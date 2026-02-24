/**
 * OAuth LLM Call Module
 *
 * Self-contained module for making LLM calls through OAuth-authenticated providers:
 *   - Google Antigravity (Cloud Code Assist gateway)
 *   - Google Gemini CLI (Cloud Code Assist gateway)
 *   - GitHub Copilot (OpenAI-compatible chat/completions)
 *   - OpenAI Codex (OpenAI chat/completions)
 *   - Anthropic (Anthropic Messages API)
 *
 * Ported from pi-mono/packages/ai/src/providers/
 * Adapted for Obsidian's Electron environment:
 *   - Uses obsidianFetch() instead of native fetch() for CORS bypass
 *   - Hardcodes version strings instead of reading process.env
 *   - Non-streaming (Obsidian's requestUrl doesn't support ReadableStream)
 */

import { obsidianFetch } from '../../auth/oauth/obsidian-fetch'

// ============================================================================
// Constants
// ============================================================================

// Cloud Code Assist endpoints (pi-mono google-gemini-cli.ts lines 60-62)
const CCA_DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const CCA_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [CCA_DAILY_ENDPOINT, CCA_DEFAULT_ENDPOINT] as const
const GEMINI_CLI_ENDPOINTS = [CCA_DEFAULT_ENDPOINT] as const

// Other provider endpoints
const COPILOT_ENDPOINT = 'https://api.individual.githubcopilot.com'
const OPENAI_ENDPOINT = 'https://api.openai.com'
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com'

/** pi-mono line 75 */
const DEFAULT_ANTIGRAVITY_VERSION = '1.15.8'

/** Retry config (pi-mono lines 100-102) */
const MAX_RETRIES = 2
const BASE_DELAY_MS = 2000

// ============================================================================
// Provider-specific Headers
// ============================================================================

/** Antigravity headers (pi-mono getAntigravityHeaders() line 77) */
function getAntigravityHeaders(): Record<string, string> {
  return {
    'User-Agent': `antigravity/${DEFAULT_ANTIGRAVITY_VERSION} darwin/arm64`,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  }
}

/** Gemini CLI headers (pi-mono GEMINI_CLI_HEADERS line 64) */
function getGeminiCliHeaders(): Record<string, string> {
  return {
    'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  }
}

/** GitHub Copilot headers (pi-mono github-copilot-headers.ts) */
function getCopilotHeaders(): Record<string, string> {
  return {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
  }
}

// ============================================================================
// Types
// ============================================================================

/** All supported OAuth provider IDs */
export type OAuthLLMProviderId =
  | 'google-antigravity'
  | 'google-gemini-cli'
  | 'github-copilot'
  | 'openai-codex'
  | 'anthropic'

/** Credentials for Cloud Code Assist (Antigravity / Gemini CLI) */
export interface CCACredentials {
  token: string
  projectId: string
}

/** A model discovered from / available through an OAuth provider */
export interface DiscoveredModel {
  id: string
  model: string
  name: string
  oauthProviderId: string
}

// ============================================================================
// Custom error class
// ============================================================================

export class CloudCodeAssistError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean = false,
  ) {
    super(message)
    this.name = 'CloudCodeAssistError'
  }
}

// ============================================================================
// Cloud Code Assist Envelope (Antigravity / Gemini CLI)
// From pi-mono buildRequest() at line 838
// ============================================================================

interface CloudCodeAssistEnvelope {
  project: string
  model: string
  request: {
    contents: Array<{ role?: string; parts: Array<{ text: string }> }>
    generationConfig?: { temperature?: number; maxOutputTokens?: number }
  }
  requestType?: string
  userAgent: string
  requestId: string
}

function buildCCAEnvelope(
  prompt: string,
  modelId: string,
  projectId: string,
  providerId: 'google-antigravity' | 'google-gemini-cli',
): CloudCodeAssistEnvelope {
  const isAntigravity = providerId === 'google-antigravity'
  const prefix = isAntigravity ? 'agent' : 'pi'
  const randomSuffix = Math.random().toString(36).slice(2, 11)

  const envelope: CloudCodeAssistEnvelope = {
    project: projectId,
    model: modelId,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    },
    userAgent: isAntigravity ? 'antigravity' : 'pi-coding-agent',
    requestId: `${prefix}-${Date.now()}-${randomSuffix}`,
  }

  if (isAntigravity) {
    envelope.requestType = 'agent'
  }

  return envelope
}

// ============================================================================
// Response Parsing — Cloud Code Assist
// ============================================================================

interface CloudCodeAssistResponse {
  response?: {
    candidates?: Array<{
      content?: {
        role?: string
        parts?: Array<{ text?: string; thought?: boolean }>
      }
      finishReason?: string
    }>
    usageMetadata?: Record<string, number>
  }
}

function extractCCAText(data: CloudCodeAssistResponse): string {
  const parts = data.response?.candidates?.[0]?.content?.parts
  if (!parts) return ''
  return parts.filter(p => !p.thought && p.text).map(p => p.text!).join('')
}

// ============================================================================
// Response Parsing — OpenAI / Copilot / Codex
// ============================================================================

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string; role?: string }
    finish_reason?: string
  }>
}

function extractOpenAIText(data: OpenAIResponse): string {
  return data.choices?.[0]?.message?.content || ''
}

// ============================================================================
// Response Parsing — Anthropic Messages API
// ============================================================================

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  stop_reason?: string
}

function extractAnthropicText(data: AnthropicResponse): string {
  if (!data.content) return ''
  return data.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('')
}

// ============================================================================
// Error Detection
// ============================================================================

function isRetryableStatus(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true
  }
  return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable/i.test(errorText)
}

// ============================================================================
// Provider-Specific Call Implementations
// ============================================================================

/**
 * Cloud Code Assist call (Antigravity / Gemini CLI).
 * Non-streaming, with endpoint fallback and retry.
 */
async function callCloudCodeAssist(
  prompt: string,
  modelId: string,
  credentials: CCACredentials,
  providerId: 'google-antigravity' | 'google-gemini-cli',
): Promise<string> {
  const isAntigravity = providerId === 'google-antigravity'
  const endpoints = isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : GEMINI_CLI_ENDPOINTS
  const headers = isAntigravity ? getAntigravityHeaders() : getGeminiCliHeaders()

  const envelope = buildCCAEnvelope(prompt, modelId, credentials.projectId, providerId)
  const bodyJson = JSON.stringify(envelope)

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
    ...headers,
  }

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const endpoint = endpoints[Math.min(attempt, endpoints.length - 1)]
    const url = `${endpoint}/v1internal:streamGenerateContent`

    try {
      const response = await obsidianFetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: bodyJson,
      })

      if (response.ok) {
        const data = (await response.json()) as CloudCodeAssistResponse
        const text = extractCCAText(data)
        if (text) return text
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
          continue
        }
        return ''
      }

      const errorText = await response.text()

      if (response.status === 401 || response.status === 403) {
        throw new CloudCodeAssistError(
          `Authentication failed (${response.status}): ${extractErrorMessage(errorText)}`,
          response.status, false,
        )
      }

      if (isRetryableStatus(response.status, errorText)) {
        lastError = new CloudCodeAssistError(
          `Gateway error (${response.status}): ${extractErrorMessage(errorText)}`,
          response.status, true,
        )
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
          continue
        }
      } else {
        throw new CloudCodeAssistError(
          `Gateway error (${response.status}): ${extractErrorMessage(errorText)}`,
          response.status, false,
        )
      }
    } catch (error) {
      if (error instanceof CloudCodeAssistError && !error.retryable) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
      }
    }
  }

  throw lastError || new Error('Cloud Code Assist call failed after all retries')
}

/**
 * GitHub Copilot call — OpenAI-compatible chat/completions with Copilot headers.
 * Source: pi-mono models.generated.ts (github-copilot models use anthropic-messages
 * and openai-completions APIs). We use the OpenAI chat/completions format here
 * which works for all Copilot models.
 */
async function callCopilot(
  prompt: string,
  modelId: string,
  token: string,
): Promise<string> {
  const url = `${COPILOT_ENDPOINT}/chat/completions`

  const response = await obsidianFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...getCopilotHeaders(),
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new CloudCodeAssistError(
      `Copilot error (${response.status}): ${extractErrorMessage(errorText)}`,
      response.status,
      isRetryableStatus(response.status, errorText),
    )
  }

  const data = (await response.json()) as OpenAIResponse
  return extractOpenAIText(data)
}

/**
 * OpenAI Codex call — standard OpenAI chat/completions.
 */
async function callOpenAICodex(
  prompt: string,
  modelId: string,
  token: string,
): Promise<string> {
  const url = `${OPENAI_ENDPOINT}/v1/chat/completions`

  const response = await obsidianFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new CloudCodeAssistError(
      `OpenAI error (${response.status}): ${extractErrorMessage(errorText)}`,
      response.status,
      isRetryableStatus(response.status, errorText),
    )
  }

  const data = (await response.json()) as OpenAIResponse
  return extractOpenAIText(data)
}

/**
 * Anthropic call — Messages API.
 * Uses x-api-key header (not Bearer) per Anthropic's API spec.
 */
async function callAnthropic(
  prompt: string,
  modelId: string,
  token: string,
): Promise<string> {
  const url = `${ANTHROPIC_ENDPOINT}/v1/messages`

  const response = await obsidianFetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new CloudCodeAssistError(
      `Anthropic error (${response.status}): ${extractErrorMessage(errorText)}`,
      response.status,
      isRetryableStatus(response.status, errorText),
    )
  }

  const data = (await response.json()) as AnthropicResponse
  return extractAnthropicText(data)
}

// ============================================================================
// Unified Call Dispatcher
// ============================================================================

/**
 * Make a non-streaming LLM call through any OAuth provider.
 *
 * Routes to the correct provider implementation based on providerId:
 * - google-antigravity / google-gemini-cli → Cloud Code Assist gateway
 * - github-copilot → Copilot chat/completions
 * - openai-codex → OpenAI chat/completions
 * - anthropic → Anthropic Messages API
 *
 * @param prompt - The text prompt to send
 * @param modelId - Model identifier for the provider's API
 * @param apiKey - Raw token string, or JSON.stringify({token, projectId}) for CCA providers
 * @param providerId - Which OAuth provider to route through
 */
export async function oauthLLMCall(
  prompt: string,
  modelId: string,
  apiKey: string,
  providerId: OAuthLLMProviderId,
): Promise<string> {
  switch (providerId) {
    case 'google-antigravity':
    case 'google-gemini-cli': {
      let credentials: CCACredentials
      try {
        credentials = JSON.parse(apiKey) as CCACredentials
      } catch {
        throw new Error('Invalid Cloud Code Assist credentials. Please logout and login again.')
      }
      if (!credentials.token || !credentials.projectId) {
        throw new Error('Missing token or projectId. Please logout and login again.')
      }
      return callCloudCodeAssist(prompt, modelId, credentials, providerId)
    }

    case 'github-copilot':
      return callCopilot(prompt, modelId, apiKey)

    case 'openai-codex':
      return callOpenAICodex(prompt, modelId, apiKey)

    case 'anthropic':
      return callAnthropic(prompt, modelId, apiKey)

    default:
      throw new Error(`Unsupported OAuth provider: ${providerId}`)
  }
}

// Legacy export alias for backward compatibility with main.ts
export const cloudCodeAssistCall = callCloudCodeAssist

// ============================================================================
// Model Discovery
// ============================================================================

/** Antigravity models (pi-mono models.generated.ts lines 3277-3413) */
const FALLBACK_ANTIGRAVITY_MODELS: DiscoveredModel[] = [
  { id: 'oauth-antigravity/claude-opus-4-6-thinking', model: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/claude-opus-4-5-thinking', model: 'claude-opus-4-5-thinking', name: 'Claude Opus 4.5 Thinking', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/claude-sonnet-4-5', model: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/claude-sonnet-4-5-thinking', model: 'claude-sonnet-4-5-thinking', name: 'Claude Sonnet 4.5 Thinking', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/gemini-3-flash', model: 'gemini-3-flash', name: 'Gemini 3 Flash', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/gemini-3-pro-high', model: 'gemini-3-pro-high', name: 'Gemini 3 Pro High', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/gemini-3-pro-low', model: 'gemini-3-pro-low', name: 'Gemini 3 Pro Low', oauthProviderId: 'google-antigravity' },
  { id: 'oauth-antigravity/gpt-oss-120b-medium', model: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B Medium', oauthProviderId: 'google-antigravity' },
]

/** Gemini CLI models (pi-mono models.generated.ts lines 3415+) */
const FALLBACK_GEMINI_CLI_MODELS: DiscoveredModel[] = [
  { id: 'oauth-gemini-cli/gemini-2.0-flash', model: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', oauthProviderId: 'google-gemini-cli' },
  { id: 'oauth-gemini-cli/gemini-2.5-flash', model: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', oauthProviderId: 'google-gemini-cli' },
  { id: 'oauth-gemini-cli/gemini-2.5-pro', model: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', oauthProviderId: 'google-gemini-cli' },
  { id: 'oauth-gemini-cli/gemini-3-flash-preview', model: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', oauthProviderId: 'google-gemini-cli' },
  { id: 'oauth-gemini-cli/gemini-3-pro-preview', model: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', oauthProviderId: 'google-gemini-cli' },
]

/** GitHub Copilot models (pi-mono models.generated.ts — selected popular models) */
const FALLBACK_COPILOT_MODELS: DiscoveredModel[] = [
  { id: 'oauth-copilot/claude-sonnet-4.5', model: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/claude-sonnet-4', model: 'claude-sonnet-4', name: 'Claude Sonnet 4', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/claude-opus-4.6', model: 'claude-opus-4.6', name: 'Claude Opus 4.6', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/gpt-4o', model: 'gpt-4o', name: 'GPT-4o', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/gpt-4.1', model: 'gpt-4.1', name: 'GPT-4.1', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/gemini-2.5-pro', model: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', oauthProviderId: 'github-copilot' },
  { id: 'oauth-copilot/gpt-5', model: 'gpt-5', name: 'GPT-5', oauthProviderId: 'github-copilot' },
]

/** OpenAI Codex models (pi-mono models.generated.ts) */
const FALLBACK_CODEX_MODELS: DiscoveredModel[] = [
  { id: 'oauth-codex/gpt-5.1', model: 'gpt-5.1', name: 'GPT-5.1', oauthProviderId: 'openai-codex' },
  { id: 'oauth-codex/gpt-5.1-codex-mini', model: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', oauthProviderId: 'openai-codex' },
  { id: 'oauth-codex/gpt-5.2', model: 'gpt-5.2', name: 'GPT-5.2', oauthProviderId: 'openai-codex' },
  { id: 'oauth-codex/gpt-5.2-codex', model: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', oauthProviderId: 'openai-codex' },
]

/** Anthropic models (popular Claude models available via direct API) */
const FALLBACK_ANTHROPIC_MODELS: DiscoveredModel[] = [
  { id: 'oauth-anthropic/claude-opus-4-6', model: 'claude-opus-4-6', name: 'Claude Opus 4.6', oauthProviderId: 'anthropic' },
  { id: 'oauth-anthropic/claude-opus-4-5', model: 'claude-opus-4-5', name: 'Claude Opus 4.5', oauthProviderId: 'anthropic' },
  { id: 'oauth-anthropic/claude-sonnet-4-5', model: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', oauthProviderId: 'anthropic' },
  { id: 'oauth-anthropic/claude-haiku-4-5', model: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', oauthProviderId: 'anthropic' },
]

/** Map provider IDs to their fallback model lists */
const PROVIDER_MODELS: Record<string, DiscoveredModel[]> = {
  'google-antigravity': FALLBACK_ANTIGRAVITY_MODELS,
  'google-gemini-cli': FALLBACK_GEMINI_CLI_MODELS,
  'github-copilot': FALLBACK_COPILOT_MODELS,
  'openai-codex': FALLBACK_CODEX_MODELS,
  'anthropic': FALLBACK_ANTHROPIC_MODELS,
}

/**
 * Discover available models for an OAuth provider.
 *
 * For Cloud Code Assist providers (Antigravity, Gemini CLI):
 *   Validates gateway access via loadCodeAssist endpoint.
 *
 * For other providers (Copilot, Codex, Anthropic):
 *   Returns the fallback model list directly — these APIs don't have
 *   a lightweight discovery endpoint, and the actual call will validate
 *   auth with a clear error if the token is invalid.
 */
export async function discoverModels(
  credentials: CCACredentials | string,
  providerId: string,
): Promise<DiscoveredModel[]> {
  const fallback = PROVIDER_MODELS[providerId]
  if (!fallback) return []

  // For non-CCA providers, just return the model list.
  // Token validity will be checked on first actual LLM call.
  if (providerId !== 'google-antigravity' && providerId !== 'google-gemini-cli') {
    return fallback
  }

  // CCA providers: validate gateway access
  const ccaCreds = typeof credentials === 'string'
    ? (() => { try { return JSON.parse(credentials) as CCACredentials } catch { return null } })()
    : credentials

  if (!ccaCreds?.token) return fallback

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ccaCreds.token}`,
    'Content-Type': 'application/json',
    ...(providerId === 'google-antigravity' ? getAntigravityHeaders() : getGeminiCliHeaders()),
  }

  const metadataBody = JSON.stringify({
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  })

  const endpoints = providerId === 'google-antigravity'
    ? ANTIGRAVITY_ENDPOINT_FALLBACKS
    : GEMINI_CLI_ENDPOINTS

  for (const endpoint of endpoints) {
    try {
      const response = await obsidianFetch(
        `${endpoint}/v1internal:loadCodeAssist`,
        { method: 'POST', headers, body: metadataBody },
      )

      if (response.ok) return fallback
      if (response.status === 401 || response.status === 403) {
        console.warn(`[OAuthLLM] Gateway auth failed for ${providerId}:`, response.status)
        return []
      }
    } catch {
      // Try next endpoint
    }
  }

  // All endpoints failed — return fallback, actual calls will give better errors
  return fallback
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractErrorMessage(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch { /* Not JSON */ }
  return errorText.length > 300 ? errorText.substring(0, 300) + '...' : errorText
}
