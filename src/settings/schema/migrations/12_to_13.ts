import { SettingMigration } from '../setting.types'

/**
 * Migration from version 12 to version 13
 * - Add oauthCredentials: Record<string, OAuthCredentials> for multi-provider OAuth
 * - Add lightRagOAuthProvider: string for selecting which OAuth provider LightRAG uses
 * - Add enableProactiveDiscovery: boolean for editor-change semantic link suggestions
 */
export const migrateFrom12To13: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 13

  // Multi-provider OAuth credential store
  // Empty by default — users opt in via Login command
  if (!newData.oauthCredentials) {
    newData.oauthCredentials = {}
  }

  // Which OAuth provider to use for LightRAG backend
  // Empty string = use existing API key from provider settings (default behavior)
  if (!newData.lightRagOAuthProvider) {
    newData.lightRagOAuthProvider = ''
  }

  // Proactive discovery: debounced editor listener for semantic link suggestions
  if (newData.enableProactiveDiscovery === undefined) {
    newData.enableProactiveDiscovery = false
  }

  return newData
}
