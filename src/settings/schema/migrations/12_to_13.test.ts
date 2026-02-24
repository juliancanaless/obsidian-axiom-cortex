import { migrateFrom12To13 } from './12_to_13'

describe('Migration from v12 to v13', () => {
  it('should increment version to 13', () => {
    const oldSettings = {
      version: 12,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.version).toBe(13)
  })

  it('should add empty oauthCredentials object', () => {
    const oldSettings = {
      version: 12,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.oauthCredentials).toEqual({})
  })

  it('should add empty lightRagOAuthProvider string', () => {
    const oldSettings = {
      version: 12,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.lightRagOAuthProvider).toBe('')
  })

  it('should add enableProactiveDiscovery as false', () => {
    const oldSettings = {
      version: 12,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.enableProactiveDiscovery).toBe(false)
  })

  it('should preserve existing settings', () => {
    const oldSettings = {
      version: 12,
      chatModels: [{ id: 'test-model' }],
      providers: [{ id: 'openai', type: 'openai' }],
      lightRagQueryMode: 'hybrid',
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.chatModels).toEqual([{ id: 'test-model' }])
    expect(result.providers).toEqual([{ id: 'openai', type: 'openai' }])
    expect(result.lightRagQueryMode).toBe('hybrid')
  })

  it('should not overwrite oauthCredentials if already present', () => {
    const existingCreds = {
      'anthropic': { refresh: 'r', access: 'a', expires: 9999 },
    }
    const oldSettings = {
      version: 12,
      oauthCredentials: existingCreds,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.oauthCredentials).toEqual(existingCreds)
  })

  it('should not overwrite lightRagOAuthProvider if already set', () => {
    const oldSettings = {
      version: 12,
      lightRagOAuthProvider: 'google-antigravity',
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.lightRagOAuthProvider).toBe('google-antigravity')
  })

  it('should not overwrite enableProactiveDiscovery if already set', () => {
    const oldSettings = {
      version: 12,
      enableProactiveDiscovery: true,
    }
    const result = migrateFrom12To13(oldSettings)
    expect(result.enableProactiveDiscovery).toBe(true)
  })
})
