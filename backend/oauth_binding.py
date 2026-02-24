"""
OAuth LLM Binding for LightRAG — Antigravity Request Wrapping

Reads X-OAuth-Provider and X-OAuth-Token from incoming request headers
and dispatches to the correct API endpoint with provider-specific headers
and request body wrapping.

IMPORTANT: Tokens are extracted per-request from headers, never stored globally.
This ensures no cross-contamination if multiple accounts are used.

The request wrapping logic is ported from:
  pi-mono/packages/ai/src/providers/google-gemini-cli.ts
    - buildRequest() at line 838 — Cloud Code Assist envelope construction
    - GEMINI_CLI_HEADERS at line 64 — prod endpoint headers
    - getAntigravityHeaders() at line 77 — sandbox endpoint headers
    - streamGoogleGeminiCli at line 310 — endpoint selection and dispatch

Constants that MUST stay synced with pi-mono:
  - DEFAULT_ANTIGRAVITY_VERSION = "1.15.8"
  - User-Agent for Antigravity: "antigravity/{version} darwin/arm64"
  - User-Agent for Gemini CLI: "google-cloud-sdk vscode_cloudshelleditor/0.1"
  - X-Goog-Api-Client for Antigravity: "google-cloud-sdk vscode_cloudshelleditor/0.1"
  - X-Goog-Api-Client for Gemini CLI: "gl-node/22.17.0"
  - requestType for Antigravity: "agent"
  - userAgent for Antigravity: "antigravity"
  - userAgent for Gemini CLI: "pi-coding-agent"
  - Endpoint: /v1internal:streamGenerateContent
  - Copilot User-Agent: "GitHubCopilotChat/0.35.0"

Integration:
  This module is designed as a FastAPI middleware or dependency.
  Import `extract_oauth_context` and `make_oauth_request` in your LightRAG server code.
"""

import os
import json
import time
import httpx
from typing import Optional, Dict, Any, Tuple
from dataclasses import dataclass


# ============================================================================
# Provider Configurations
# Ported from pi-mono/packages/ai/src/providers/google-gemini-cli.ts
# ============================================================================

# pi-mono line 75: const DEFAULT_ANTIGRAVITY_VERSION = "1.15.8";
DEFAULT_ANTIGRAVITY_VERSION = "1.15.8"

@dataclass
class OAuthContext:
    """Per-request OAuth context extracted from headers."""
    provider: str
    token: str
    project_id: Optional[str] = None
    account_id: Optional[str] = None
    enterprise_url: Optional[str] = None


def _antigravity_headers() -> Dict[str, str]:
    """
    Headers for the Antigravity sandbox endpoint.
    
    Source: pi-mono/packages/ai/src/providers/google-gemini-cli.ts
           getAntigravityHeaders() at line 77
    
    Must match exactly:
      User-Agent: "antigravity/{version} darwin/arm64"
      X-Goog-Api-Client: "google-cloud-sdk vscode_cloudshelleditor/0.1"
      Client-Metadata: JSON with ideType, platform, pluginType
    """
    version = os.getenv("PI_AI_ANTIGRAVITY_VERSION", DEFAULT_ANTIGRAVITY_VERSION)
    return {
        "User-Agent": f"antigravity/{version} darwin/arm64",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": json.dumps({
            "ideType": "IDE_UNSPECIFIED",
            "platform": "PLATFORM_UNSPECIFIED",
            "pluginType": "GEMINI",
        }),
    }


def _gemini_cli_headers() -> Dict[str, str]:
    """
    Headers for the Gemini CLI prod endpoint.
    
    Source: pi-mono/packages/ai/src/providers/google-gemini-cli.ts
           GEMINI_CLI_HEADERS at line 64
    
    Must match exactly:
      User-Agent: "google-cloud-sdk vscode_cloudshelleditor/0.1"
      X-Goog-Api-Client: "gl-node/22.17.0"
    """
    return {
        "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata": json.dumps({
            "ideType": "IDE_UNSPECIFIED",
            "platform": "PLATFORM_UNSPECIFIED",
            "pluginType": "GEMINI",
        }),
    }


def _copilot_headers() -> Dict[str, str]:
    """
    Headers for GitHub Copilot endpoint.
    
    Source: pi-mono/packages/ai/src/providers/github-copilot-headers.ts
    """
    return {
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
        "Openai-Intent": "conversation-edits",
    }


# Endpoint configuration per provider
# Source: pi-mono/packages/ai/src/providers/google-gemini-cli.ts lines 60-62
PROVIDER_CONFIGS = {
    "google-antigravity": {
        # pi-mono: ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, DEFAULT_ENDPOINT]
        "endpoints": [
            "https://daily-cloudcode-pa.sandbox.googleapis.com",
            "https://cloudcode-pa.googleapis.com",
        ],
        "path": "/v1internal:streamGenerateContent",
        "headers_fn": _antigravity_headers,
        "body_wrapper": "cloud_code_assist",
        "auth_type": "bearer",
    },
    "google-gemini-cli": {
        # pi-mono: [DEFAULT_ENDPOINT]
        "endpoints": ["https://cloudcode-pa.googleapis.com"],
        "path": "/v1internal:streamGenerateContent",
        "headers_fn": _gemini_cli_headers,
        "body_wrapper": "cloud_code_assist",
        "auth_type": "bearer",
    },
    "github-copilot": {
        "endpoints": ["https://api.individual.githubcopilot.com"],
        "path": "/chat/completions",
        "headers_fn": _copilot_headers,
        "body_wrapper": "openai",
        "auth_type": "bearer",
    },
    "anthropic": {
        "endpoints": ["https://api.anthropic.com"],
        "path": "/v1/messages",
        "headers_fn": lambda: {},
        "body_wrapper": "anthropic",
        "auth_type": "bearer",
    },
    "openai-codex": {
        "endpoints": ["https://api.openai.com"],
        "path": "/v1/chat/completions",
        "headers_fn": lambda: {},
        "body_wrapper": "openai",
        "auth_type": "bearer",
    },
}


# ============================================================================
# Request Header Extraction (per-request, no global state)
# ============================================================================

def extract_oauth_context(headers: Dict[str, str]) -> Optional[OAuthContext]:
    """
    Extract OAuth context from incoming request headers.
    Returns None if no OAuth headers present (fallback to env-based credentials).
    
    Headers read:
      - X-OAuth-Provider: provider ID (e.g., 'google-antigravity')
      - X-OAuth-Token: API key or JSON-encoded token
    
    For Antigravity/Gemini CLI, the token is JSON: {"token": "...", "projectId": "..."}
    This matches the output of provider.getApiKey() in pi-mono's
    google-antigravity.ts and google-gemini-cli.ts.
    """
    provider = headers.get("X-OAuth-Provider") or headers.get("x-oauth-provider")
    token = headers.get("X-OAuth-Token") or headers.get("x-oauth-token")
    
    if not provider or not token:
        return None
    
    project_id = None
    actual_token = token
    
    # Antigravity and Gemini CLI encode projectId in the token as JSON
    # Source: pi-mono google-antigravity.ts getApiKey():
    #   return JSON.stringify({ token: creds.access, projectId: creds.projectId });
    if provider in ("google-antigravity", "google-gemini-cli"):
        try:
            parsed = json.loads(token)
            actual_token = parsed.get("token", token)
            project_id = parsed.get("projectId")
        except (json.JSONDecodeError, TypeError):
            pass
    
    return OAuthContext(
        provider=provider,
        token=actual_token,
        project_id=project_id,
    )


# ============================================================================
# Cloud Code Assist Request Wrapping
#
# Ported from pi-mono/packages/ai/src/providers/google-gemini-cli.ts
# buildRequest() function at line 838.
#
# The Antigravity/Gemini CLI gateway expects requests wrapped in an envelope:
# {
#   "project": "...",           ← from OAuth credentials
#   "model": "...",             ← model identifier
#   "request": { ... },        ← the actual LLM request body
#   "requestType": "agent",    ← REQUIRED for Antigravity (pi-mono line 911)
#   "userAgent": "antigravity", ← identifies the client (pi-mono line 912)
#   "requestId": "agent-...",  ← unique request ID (pi-mono line 913)
# }
# ============================================================================

def _wrap_cloud_code_assist(body: Dict[str, Any], ctx: OAuthContext, model: str) -> Dict[str, Any]:
    """
    Wrap request body in Cloud Code Assist envelope.
    
    Source: pi-mono/packages/ai/src/providers/google-gemini-cli.ts lines 908-914
    
    Key constants from pi-mono:
      - requestType: "agent" for Antigravity, omitted for Gemini CLI
      - userAgent: "antigravity" for Antigravity, "pi-coding-agent" for Gemini CLI
      - requestId: "{prefix}-{timestamp}-{random}" 
    """
    is_antigravity = ctx.provider == "google-antigravity"
    prefix = "agent" if is_antigravity else "pi"
    random_suffix = os.urandom(5).hex()[:9]  # 9 chars to match Math.random().toString(36).slice(2, 11)
    
    envelope: Dict[str, Any] = {
        "project": ctx.project_id or "",
        "model": model,
        "request": body,
        "userAgent": "antigravity" if is_antigravity else "pi-coding-agent",
        "requestId": f"{prefix}-{int(time.time() * 1000)}-{random_suffix}",
    }
    
    # requestType is only set for Antigravity, not Gemini CLI
    # Source: pi-mono line 911: ...(isAntigravity ? { requestType: "agent" } : {}),
    if is_antigravity:
        envelope["requestType"] = "agent"
    
    return envelope


def _build_auth_headers(ctx: OAuthContext, config: dict) -> Dict[str, str]:
    """Build authentication and provider-specific headers."""
    headers = {
        "Authorization": f"Bearer {ctx.token}",
        "Content-Type": "application/json",
    }
    
    # Add provider-specific headers (User-Agent, X-Goog-Api-Client, etc.)
    provider_headers = config["headers_fn"]()
    headers.update(provider_headers)
    
    return headers


# ============================================================================
# Retryable Error Detection
# Ported from pi-mono/packages/ai/src/providers/google-gemini-cli.ts
# isRetryableError() function
# ============================================================================

def _is_retryable_error(status_code: int, error_text: str) -> bool:
    """Check if an error is retryable (rate limits, transient failures)."""
    if status_code == 429:
        return True
    if status_code >= 500:
        return True
    # Resource exhausted
    if "RESOURCE_EXHAUSTED" in error_text.upper():
        return True
    return False


async def make_oauth_request(
    ctx: OAuthContext,
    body: Dict[str, Any],
    model: str = "",
    stream: bool = False,
    max_retries: int = 2,
) -> Tuple[int, Dict[str, Any]]:
    """
    Make an outbound API request using OAuth credentials.
    
    Implements the retry logic from pi-mono's streamGoogleGeminiCli():
    - Try endpoints in order (Antigravity: daily sandbox first, then prod)
    - Retry on 429/5xx with exponential backoff
    - Return on any <500 response (including 401 for upstream handling)
    
    Args:
        ctx: Per-request OAuth context (from extract_oauth_context)
        body: Request body (standard LLM format)
        model: Model identifier
        stream: Whether to use streaming
        max_retries: Maximum retry attempts (default 2, matching pi-mono MAX_RETRIES)
    
    Returns:
        Tuple of (status_code, response_json)
    """
    config = PROVIDER_CONFIGS.get(ctx.provider)
    if not config:
        return 400, {"error": f"Unknown OAuth provider: {ctx.provider}"}
    
    headers = _build_auth_headers(ctx, config)
    
    # Wrap body if needed
    request_body = body
    if config["body_wrapper"] == "cloud_code_assist":
        request_body = _wrap_cloud_code_assist(body, ctx, model)
    
    # Try endpoints with retry logic
    # Source: pi-mono google-gemini-cli.ts lines 381-410
    endpoints = config["endpoints"]
    last_error = None
    base_delay_ms = 2000  # pi-mono: BASE_DELAY_MS = 2000
    
    for attempt in range(max_retries + 1):
        endpoint = endpoints[min(attempt, len(endpoints) - 1)]
        url = f"{endpoint}{config['path']}"
        
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                response = await client.post(
                    url,
                    headers=headers,
                    json=request_body,
                )
                
                if response.status_code < 400:
                    # Success
                    try:
                        return response.status_code, response.json()
                    except Exception:
                        return response.status_code, {"response": response.text}
                
                error_text = response.text[:500]
                
                # Non-retryable errors (401, 403, 404, etc.) — return immediately
                if not _is_retryable_error(response.status_code, error_text):
                    try:
                        return response.status_code, response.json()
                    except Exception:
                        return response.status_code, {"error": error_text}
                
                # Retryable error — exponential backoff
                if attempt < max_retries:
                    import asyncio
                    delay_s = (base_delay_ms * (2 ** attempt)) / 1000
                    await asyncio.sleep(delay_s)
                    last_error = f"{response.status_code}: {error_text}"
                    continue
                
                last_error = f"{response.status_code}: {error_text}"
        except Exception as e:
            last_error = str(e)
            if attempt < max_retries:
                import asyncio
                delay_s = (base_delay_ms * (2 ** attempt)) / 1000
                await asyncio.sleep(delay_s)
                continue
    
    return 502, {"error": f"All endpoints failed after {max_retries + 1} attempts. Last error: {last_error}"}


# ============================================================================
# FastAPI Integration
# ============================================================================

"""
Usage in your LightRAG FastAPI server:

    from oauth_middleware import OAuthInjectionMiddleware
    from oauth_binding import extract_oauth_context, make_oauth_request

    # Add middleware for automatic env var injection (Strategy B)
    app.add_middleware(OAuthInjectionMiddleware)

    # For routes that make outbound LLM calls directly:
    @app.post("/query")
    async def query(request: Request, body: QueryRequest):
        # Option A: Let middleware handle env vars (LightRAG reads os.environ)
        # Just call LightRAG normally — the middleware already set the env vars.
        
        # Option B: Use oauth_binding for direct API dispatch
        ctx = extract_oauth_context(dict(request.headers))
        if ctx:
            status, result = await make_oauth_request(
                ctx=ctx,
                body={"contents": [{"parts": [{"text": body.query}]}]},
                model=body.model or "gemini-2.5-flash",
            )
            if status >= 400:
                raise HTTPException(status_code=status, detail=result)
            return result
        
        # Fallback — use env-based API keys (existing behavior)
        ...
"""
