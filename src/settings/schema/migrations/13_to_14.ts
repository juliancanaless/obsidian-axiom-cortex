import { SettingMigration } from '../setting.types'

/**
 * Migration from version 13 to version 14
 * - Add oauthModels: array of models discovered from OAuth providers (Antigravity, etc.)
 *   These models are populated dynamically when the user logs in via OAuth
 *   and cleared when they log out.
 */
export const migrateFrom13To14: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 14

  // OAuth-discovered models (populated by model discovery, cleared on logout)
  if (!Array.isArray(newData.oauthModels)) {
    newData.oauthModels = []
  }

  return newData
}
