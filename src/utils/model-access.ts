import { PROVIDER_TYPES_INFO } from '../constants'
import { NeuralComposerSettings } from '../settings/schema/setting.types'
import { ChatModel } from '../types/chat-model.types'
import { EmbeddingModel } from '../types/embedding-model.types'
import { LLMProvider, LLMProviderType } from '../types/provider.types'

/**
 * Check whether a provider is "configured" — i.e. the user has supplied
 * the credentials needed to actually call the API.
 *
 * - Providers that don't require an API key (ollama, lm-studio,
 *   openai-compatible) are always considered configured.
 * - Everything else needs a non-empty `apiKey`.
 */
export function isProviderConfigured(provider: LLMProvider): boolean {
  const info = PROVIDER_TYPES_INFO[provider.type]
  if (!info.requireApiKey) {
    return true // local providers are always accessible
  }
  return !!provider.apiKey && provider.apiKey.trim().length > 0
}

/**
 * Build a Set of provider IDs that the user actually has access to
 * (non-empty API key, or provider type that doesn't need one).
 */
export function getConfiguredProviderIds(
  providers: readonly LLMProvider[],
): Set<string> {
  const ids = new Set<string>()
  for (const provider of providers) {
    if (isProviderConfigured(provider)) {
      ids.add(provider.id)
    }
  }
  return ids
}

/**
 * Return only the chat models whose provider is configured.
 * Respects the existing `enable` toggle — a model must be both
 * enabled *and* its provider configured to appear.
 */
export function getAccessibleChatModels(
  settings: NeuralComposerSettings,
): ChatModel[] {
  const configuredIds = getConfiguredProviderIds(settings.providers)
  return settings.chatModels.filter(
    (m) => (m.enable ?? true) && configuredIds.has(m.providerId),
  )
}

/**
 * Return only the embedding models whose provider is configured.
 */
export function getAccessibleEmbeddingModels(
  settings: NeuralComposerSettings,
): EmbeddingModel[] {
  const configuredIds = getConfiguredProviderIds(settings.providers)
  return settings.embeddingModels.filter((m) =>
    configuredIds.has(m.providerId),
  )
}
