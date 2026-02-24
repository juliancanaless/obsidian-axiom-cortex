"""
Strategy B: Per-request OAuth token injection middleware for LightRAG.

This middleware intercepts incoming requests from the Obsidian plugin,
extracts X-OAuth-Provider and X-OAuth-Token headers, and temporarily
overrides the process-level API key environment variables for the
duration of that specific request.

This eliminates the need for server restarts when OAuth tokens change
(Strategy A), since every request carries its own fresh token.

Integration:
    from oauth_middleware import OAuthInjectionMiddleware
    app.add_middleware(OAuthInjectionMiddleware)

How it works:
  1. Plugin sends X-OAuth-Provider + X-OAuth-Token headers with every request
  2. Middleware maps the token to the correct env var based on provider:
       - google-antigravity → GEMINI_API_KEY (JSON: {token, projectId})
       - google-gemini-cli  → GEMINI_API_KEY (JSON: {token, projectId})
       - github-copilot     → OPENAI_API_KEY
       - anthropic          → ANTHROPIC_API_KEY
       - openai-codex       → OPENAI_API_KEY
  3. os.environ is patched for the request scope, then restored after

Provider mapping matches pi-mono's env-api-keys.ts precedence.
Reference: pi-mono/packages/ai/src/env-api-keys.ts
"""

import os
import json
import contextvars
from typing import Optional, Dict, Tuple

try:
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import Response
    HAS_STARLETTE = True
except ImportError:
    HAS_STARLETTE = False


# ============================================================================
# Provider → Environment Variable Mapping
#
# Determines which os.environ key to override for each OAuth provider.
# This must stay in sync with generateEnvConfig() in main.ts and
# pi-mono/packages/ai/src/env-api-keys.ts.
# ============================================================================

PROVIDER_ENV_MAP: Dict[str, str] = {
    "google-antigravity": "GEMINI_API_KEY",
    "google-gemini-cli":  "GEMINI_API_KEY",
    "github-copilot":     "OPENAI_API_KEY",
    "anthropic":          "ANTHROPIC_API_KEY",
    "openai-codex":       "OPENAI_API_KEY",
}

# Providers that encode projectId in the token as JSON
# For these, we also set GOOGLE_CLOUD_PROJECT
JSON_TOKEN_PROVIDERS = {"google-antigravity", "google-gemini-cli"}


# Context variable for per-request OAuth state (async-safe)
_oauth_env_overrides: contextvars.ContextVar[Optional[Dict[str, str]]] = \
    contextvars.ContextVar("_oauth_env_overrides", default=None)


def _parse_oauth_headers(headers: Dict[str, str]) -> Optional[Tuple[str, str]]:
    """Extract provider and token from request headers (case-insensitive)."""
    provider = headers.get("x-oauth-provider") or headers.get("X-OAuth-Provider")
    token = headers.get("x-oauth-token") or headers.get("X-OAuth-Token")
    if provider and token:
        return provider, token
    return None


def _map_token_to_env(provider: str, raw_token: str) -> Dict[str, str]:
    """
    Map an OAuth token to the environment variables that LightRAG reads.

    For Google providers, the token is JSON-encoded: {"token": "...", "projectId": "..."}
    We extract the raw access token for the API key env var and set
    GOOGLE_CLOUD_PROJECT separately.

    Reference: pi-mono's getApiKey() in each OAuth provider module.
    """
    env_key = PROVIDER_ENV_MAP.get(provider)
    if not env_key:
        return {}

    overrides: Dict[str, str] = {}

    if provider in JSON_TOKEN_PROVIDERS:
        try:
            parsed = json.loads(raw_token)
            access_token = parsed.get("token", raw_token)
            project_id = parsed.get("projectId", "")
            overrides[env_key] = access_token
            if project_id:
                overrides["GOOGLE_CLOUD_PROJECT"] = project_id
        except (json.JSONDecodeError, TypeError):
            # Not JSON — use raw token
            overrides[env_key] = raw_token
    else:
        overrides[env_key] = raw_token

    return overrides


def get_oauth_env_overrides() -> Optional[Dict[str, str]]:
    """
    Get the per-request OAuth environment overrides.

    LightRAG code that reads API keys from os.environ should call this first:

        from oauth_middleware import get_oauth_env_overrides
        overrides = get_oauth_env_overrides()
        api_key = (overrides or {}).get("OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")

    Or use get_effective_env() for a drop-in replacement.
    """
    return _oauth_env_overrides.get()


def get_effective_env(key: str, default: Optional[str] = None) -> Optional[str]:
    """
    Get an environment variable with per-request OAuth override precedence.

    Drop-in replacement for os.environ.get() that checks OAuth overrides first.
    """
    overrides = _oauth_env_overrides.get()
    if overrides and key in overrides:
        return overrides[key]
    return os.environ.get(key, default)


# ============================================================================
# Starlette/FastAPI Middleware
# ============================================================================

if HAS_STARLETTE:
    class OAuthInjectionMiddleware(BaseHTTPMiddleware):
        """
        Middleware that injects OAuth tokens into os.environ for the request scope.

        For each incoming request with X-OAuth-Provider + X-OAuth-Token headers:
        1. Maps the token to the correct API key env var
        2. Saves + overrides os.environ for the duration of the request
        3. Restores original env vars after the request completes

        This makes LightRAG's existing os.environ.get("OPENAI_API_KEY") calls
        transparently use the per-request OAuth token without any code changes
        to LightRAG's core.

        Thread safety: Uses contextvars for async frameworks. The os.environ
        patch is process-wide, so this is safe ONLY for single-request-at-a-time
        deployments (which is the case for local Obsidian → localhost:9621).
        For concurrent deployments, use get_effective_env() instead.
        """

        async def dispatch(self, request: Request, call_next) -> Response:
            headers = dict(request.headers)
            parsed = _parse_oauth_headers(headers)

            if not parsed:
                # No OAuth headers — pass through, use env-based credentials
                return await call_next(request)

            provider, raw_token = parsed
            overrides = _map_token_to_env(provider, raw_token)

            if not overrides:
                # Unknown provider — pass through
                return await call_next(request)

            # Save original values and apply overrides
            saved: Dict[str, Optional[str]] = {}
            for key, value in overrides.items():
                saved[key] = os.environ.get(key)
                os.environ[key] = value

            # Set contextvar for code that uses get_effective_env()
            token = _oauth_env_overrides.set(overrides)

            try:
                response = await call_next(request)
                return response
            finally:
                # Restore original environment
                for key, original_value in saved.items():
                    if original_value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = original_value

                # Reset contextvar
                _oauth_env_overrides.reset(token)
