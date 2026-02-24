import { migrateFrom13To14 } from './13_to_14'

describe('Migration from v13 to v14', () => {
  it('should increment version to 14', () => {
    const oldSettings = {
      version: 13,
    }
    const result = migrateFrom13To14(oldSettings)
    expect(result.version).toBe(14)
  })

  it('should add empty oauthModels array', () => {
    const oldSettings = {
      version: 13,
    }
    const result = migrateFrom13To14(oldSettings)
    expect(result.oauthModels).toEqual([])
  })

  it('should preserve existing settings', () => {
    const oldSettings = {
      version: 13,
      chatModels: [{ id: 'test-model' }],
      providers: [{ id: 'openai', type: 'openai' }],
      oauthCredentials: { 'google-antigravity': { refresh: 'r', access: 'a', expires: 9999 } },
      lightRagOAuthProvider: 'google-antigravity',
    }
    const result = migrateFrom13To14(oldSettings)
    expect(result.chatModels).toEqual([{ id: 'test-model' }])
    expect(result.providers).toEqual([{ id: 'openai', type: 'openai' }])
    expect(result.oauthCredentials).toEqual({
      'google-antigravity': { refresh: 'r', access: 'a', expires: 9999 },
    })
    expect(result.lightRagOAuthProvider).toBe('google-antigravity')
  })

  it('should not overwrite oauthModels if already present', () => {
    const existingModels = [
      { id: 'oauth-antigravity/gemini-3-flash', model: 'gemini-3-flash', name: 'Gemini 3 Flash', oauthProviderId: 'google-antigravity' },
    ]
    const oldSettings = {
      version: 13,
      oauthModels: existingModels,
    }
    const result = migrateFrom13To14(oldSettings)
    expect(result.oauthModels).toEqual(existingModels)
  })
})
