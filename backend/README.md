# Backend OAuth Integration

## How OAuth Tokens Reach LightRAG

The LightRAG server is an **external Python process** spawned by the Obsidian plugin via `child_process.spawn`. It is NOT part of this repository's code. The plugin controls its lifecycle through:

- `startLightRagServer()` — spawns the process
- `stopLightRagServer()` — kills it
- `generateEnvConfig()` — writes the `.env` config it reads at startup

### Current Token Delivery (Strategy A — .env Rewrite)

```
User logs in via OAuth → OAuthManager stores credentials
                        → OAuthManager calls plugin.updateEnvFile()
                        → generateEnvConfig() writes OAUTH_ACCESS_TOKEN to .env
                        → OAuthManager calls plugin.restartLightRagServer()
                        → LightRAG reads new .env on startup
```

When the OAuthManager detects the active provider's token is expiring (checked every 15 minutes), it:
1. Calls the provider's `refreshToken()`
2. Saves new credentials via `plugin.saveData()`
3. Rewrites `.env` via `updateEnvFile()` (includes fresh `OAUTH_ACCESS_TOKEN`)
4. Restarts the LightRAG server

**Trade-off:** ~2-3 seconds of downtime per token refresh (every ~55 minutes). Acceptable for a local knowledge graph tool.

### Environment Variables Written

When an OAuth provider is selected as the auth source for LightRAG, `generateEnvConfig()` writes the OAuth token **as the standard API key env var** that LightRAG already understands:

| OAuth Provider | Env Var Written | Why |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY=<access_token>` | LightRAG's Anthropic binding reads this |
| OpenAI Codex | `OPENAI_API_KEY=<access_token>` | LightRAG's OpenAI binding reads this |
| Antigravity / Gemini CLI | `GEMINI_API_KEY=<access_token>` + `GOOGLE_CLOUD_PROJECT=<projectId>` | LightRAG's Gemini binding reads these |
| GitHub Copilot | `OPENAI_API_KEY=<copilot_token>` | Copilot uses OpenAI-compatible API |

This means **no LightRAG server code changes are needed** for basic OAuth → API key delivery. The OAuth token is written as the last value for the API key env var, overriding any earlier manual API key from provider settings.

Additionally, generic vars are written for future `oauth_binding.py` integration:
```env
OAUTH_PROVIDER=google-antigravity
OAUTH_ACCESS_TOKEN=ya29.a0ARrdaM...
OAUTH_PROJECT_ID=rising-fact-p41fc
```

### Future: Strategy B (Per-Request Headers)

The `ragEngine.ts` already injects `X-OAuth-Provider` and `X-OAuth-Token` headers into every request to `localhost:9621`. If the LightRAG server is patched to read these headers and use them for outbound API calls (instead of reading from `.env`), the server restart on token refresh becomes unnecessary.

The files `oauth_binding.py` and `oauth_middleware.py` in this directory are the reference implementation for that patch. To use them:

1. Install them alongside your LightRAG server
2. Add the middleware: `app.add_middleware(OAuthMiddleware)`
3. In your LLM binding, check `request.state.oauth_context` before falling back to env vars

### Provider-Specific Headers

Each provider's API gateway validates specific headers. These are documented in `oauth_binding.py`:

| Provider | Key Headers |
|---|---|
| Antigravity | `User-Agent: antigravity/1.15.8 darwin/arm64`, `X-Goog-Api-Client`, `Client-Metadata` JSON |
| Gemini CLI | `User-Agent: google-cloud-sdk ...`, `X-Goog-Api-Client: gl-node/22.17.0` |
| GitHub Copilot | `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Version`, `Copilot-Integration-Id` |
| Anthropic | Standard `Authorization: Bearer <token>` |
| OpenAI Codex | Standard `Authorization: Bearer <token>` |

### Request Body Wrapping

Antigravity and Gemini CLI require wrapping the standard Gemini request body in a Cloud Code Assist envelope:

```json
{
  "project": "<projectId>",
  "model": "<modelId>",
  "request": { /* standard Gemini content */ },
  "requestType": "agent",
  "userAgent": "antigravity"
}
```

This wrapping is handled by `oauth_binding.py`'s `_wrap_cloud_code_assist()` function.
