/**
 * OAuthManager — Obsidian-adapted OAuth credential manager.
 * 
 * Responsibilities:
 * 1. showLoginSelector() — Open modal listing all OAuth providers
 * 2. login(providerId) — Dispatch to provider's .login() with Obsidian callbacks
 * 3. logout(providerId) — Clear provider credentials
 * 4. getApiKey(providerId) — Auto-refresh if expired, return API key string
 * 5. isLoggedIn(providerId) — Check if valid credentials exist
 * 6. listProviders() — All providers with login status
 * 7. refreshAllIfNeeded() — Background refresh for all providers nearing expiry
 *
 * Token delivery to LightRAG:
 *   The LightRAG server is an external Python process that reads its config from
 *   a .env file at startup. It does NOT read per-request headers for auth.
 *   
 *   Therefore, when tokens change (login, refresh, logout), this manager:
 *   1. Persists credentials via plugin.saveData()
 *   2. Rewrites the .env file (which includes OAUTH_ACCESS_TOKEN)
 *   3. Restarts the LightRAG server so it picks up the new token
 *
 *   The ragEngine.ts header injection (X-OAuth-Provider, X-OAuth-Token) is
 *   forward-looking infrastructure for when the LightRAG server is patched
 *   to read auth from request headers (eliminating restart-on-refresh).
 */

import { Notice } from 'obsidian'
import type NeuralComposerPlugin from '../main'
import {
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProviderId,
  type OAuthProviderInterface,
} from './oauth'
import { OAuthLoginModal } from '../components/modals/OAuthLoginModal'

export interface OAuthProviderStatus {
  id: string;
  name: string;
  loggedIn: boolean;
  email?: string;
  expires?: number;
}

export class OAuthManager {
  private plugin: NeuralComposerPlugin;

  constructor(plugin: NeuralComposerPlugin) {
    this.plugin = plugin;
  }

  // ========================================================================
  // Credential Storage (via plugin.saveData())
  // ========================================================================

  private getCredentials(): Record<string, OAuthCredentials> {
    return this.plugin.settings.oauthCredentials || {};
  }

  /**
   * Save credentials and sync to LightRAG if this provider is the active one.
   * When the active OAuth provider's token changes, we must rewrite .env
   * and restart the LightRAG server since it reads config only at startup.
   */
  private async saveCredentials(providerId: string, creds: OAuthCredentials): Promise<void> {
    const allCreds = { ...this.getCredentials() };
    allCreds[providerId] = creds;
    this.plugin.settings.oauthCredentials = allCreds;
    await this.plugin.saveData(this.plugin.settings);

    // If this provider is the active LightRAG auth source, sync to server
    if (this.plugin.settings.lightRagOAuthProvider === providerId) {
      this.syncToLightRagServer();
    }
  }

  private async clearCredentials(providerId: string): Promise<void> {
    const allCreds = { ...this.getCredentials() };
    delete allCreds[providerId];
    this.plugin.settings.oauthCredentials = allCreds;

    // If this was the active LightRAG OAuth provider, clear that too
    if (this.plugin.settings.lightRagOAuthProvider === providerId) {
      this.plugin.settings.lightRagOAuthProvider = '';
    }

    await this.plugin.saveData(this.plugin.settings);

    // Sync removal to LightRAG
    this.syncToLightRagServer();
  }

  /**
   * Rewrite the .env file and restart the LightRAG server.
   * This is the mechanism by which OAuth tokens reach the Python backend:
   * generateEnvConfig() writes OAUTH_PROVIDER, OAUTH_ACCESS_TOKEN, etc.
   * to .env, and the server reads them on startup.
   */
  private syncToLightRagServer(): void {
    try {
      this.plugin.updateEnvFile();
      this.plugin.restartLightRagServer();
      console.log('[OAuthManager] Synced OAuth credentials to LightRAG server');
    } catch (error) {
      console.error('[OAuthManager] Failed to sync to LightRAG server:', error);
    }
  }

  // ========================================================================
  // Provider Status
  // ========================================================================

  isLoggedIn(providerId: OAuthProviderId): boolean {
    const creds = this.getCredentials()[providerId];
    return !!creds && !!creds.access;
  }

  listProviders(): OAuthProviderStatus[] {
    const creds = this.getCredentials();
    return getOAuthProviders().map((provider) => {
      const providerCreds = creds[provider.id];
      return {
        id: provider.id,
        name: provider.name,
        loggedIn: !!providerCreds?.access,
        email: providerCreds?.email as string | undefined,
        expires: providerCreds?.expires,
      };
    });
  }

  // ========================================================================
  // Login / Logout
  // ========================================================================

  /**
   * Open the provider selector modal for login or logout.
   */
  showLoginSelector(mode: 'login' | 'logout'): void {
    const modal = new OAuthLoginModal(this.plugin.app, this, mode);
    modal.open();
  }

  /**
   * Execute the login flow for a specific provider.
   * Called by OAuthLoginModal after user selects a provider.
   */
  async login(
    providerId: OAuthProviderId,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      onManualCodeInput?: () => Promise<string>;
      signal?: AbortSignal;
    },
  ): Promise<OAuthCredentials> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks);
    await this.saveCredentials(providerId, credentials);

    return credentials;
  }

  /**
   * Logout from a specific provider — clear credentials.
   */
  async logout(providerId: OAuthProviderId): Promise<void> {
    await this.clearCredentials(providerId);
    new Notice(`Logged out from ${getOAuthProvider(providerId)?.name ?? providerId}`);
  }

  // ========================================================================
  // Token Access (with auto-refresh)
  // ========================================================================

  /**
   * Get API key for a provider, auto-refreshing if expired.
   * Returns undefined if not logged in.
   */
  async getApiKey(providerId: OAuthProviderId): Promise<string | undefined> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;

    let creds = this.getCredentials()[providerId];
    if (!creds) return undefined;

    // Refresh if expired
    if (Date.now() >= creds.expires) {
      try {
        creds = await provider.refreshToken(creds);
        await this.saveCredentials(providerId, creds);
        // saveCredentials already triggers syncToLightRagServer if this
        // is the active provider — so .env gets rewritten + server restarts
      } catch (error) {
        console.error(`[OAuthManager] Token refresh failed for ${providerId}:`, error);
        // Clear invalid credentials
        await this.clearCredentials(providerId);
        new Notice(`OAuth token expired for ${provider.name}. Please login again.`);
        return undefined;
      }
    }

    return provider.getApiKey(creds);
  }

  /**
   * Get the API key for the currently active LightRAG OAuth provider.
   * Returns undefined if no OAuth provider is selected or not logged in.
   */
  async getActiveLightRagApiKey(): Promise<{ providerId: string; apiKey: string } | undefined> {
    const providerId = this.plugin.settings.lightRagOAuthProvider;
    if (!providerId) return undefined;

    const apiKey = await this.getApiKey(providerId);
    if (!apiKey) return undefined;

    return { providerId, apiKey };
  }

  /**
   * Force-refresh the active LightRAG OAuth provider's token.
   *
   * Called reactively when the RAGEngine receives a 401/403 from the LightRAG
   * server. This mirrors pi-mono's AuthStorage.refreshOAuthTokenWithLock():
   *   1. Get the active provider's credentials
   *   2. Call provider.refreshToken(creds) unconditionally (ignore expiry check)
   *   3. Persist new credentials (triggers syncToLightRagServer for Strategy A)
   *   4. Return the fresh API key
   *
   * Reference: pi-mono/packages/coding-agent/src/core/auth-storage.ts lines 265-321
   */
  async forceRefreshActiveToken(): Promise<{ providerId: string; apiKey: string } | undefined> {
    const providerId = this.plugin.settings.lightRagOAuthProvider;
    if (!providerId) return undefined;

    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;

    const creds = this.getCredentials()[providerId];
    if (!creds?.refresh) {
      // No refresh token — can't refresh, must re-login
      console.error(`[OAuthManager] No refresh token for ${providerId}, cannot force-refresh`);
      return undefined;
    }

    try {
      const newCreds = await provider.refreshToken(creds);
      await this.saveCredentials(providerId, newCreds);
      // saveCredentials triggers syncToLightRagServer if this is the active provider
      console.log(`[OAuthManager] Force-refreshed token for ${providerId}`);
      const apiKey = provider.getApiKey(newCreds);
      return { providerId, apiKey };
    } catch (error) {
      console.error(`[OAuthManager] Force refresh failed for ${providerId}:`, error);
      // Clear invalid credentials — user must re-login
      await this.clearCredentials(providerId);
      new Notice(`OAuth token invalid for ${provider.name}. Please login again.`);
      return undefined;
    }
  }

  // ========================================================================
  // Background Refresh
  // ========================================================================

  /**
   * Refresh all tokens that are within 10 minutes of expiry.
   * Called by the 15-minute interval in main.ts.
   * 
   * When the active LightRAG provider's token is refreshed, saveCredentials()
   * automatically triggers .env rewrite + server restart.
   */
  async refreshAllIfNeeded(): Promise<void> {
    const creds = this.getCredentials();
    const refreshThreshold = Date.now() + 10 * 60 * 1000; // 10 min from now

    for (const [providerId, providerCreds] of Object.entries(creds)) {
      if (!providerCreds?.access) continue;
      if (providerCreds.expires > refreshThreshold) continue;

      const provider = getOAuthProvider(providerId);
      if (!provider) continue;

      try {
        const newCreds = await provider.refreshToken(providerCreds);
        await this.saveCredentials(providerId, newCreds);
        console.log(`[OAuthManager] Refreshed token for ${providerId}`);
      } catch (error) {
        console.error(`[OAuthManager] Background refresh failed for ${providerId}:`, error);
        // Don't clear credentials on background refresh failure — 
        // the user may just be offline temporarily.
      }
    }
  }

  /**
   * Get the underlying provider interface for a given ID.
   */
  getProvider(providerId: OAuthProviderId): OAuthProviderInterface | undefined {
    return getOAuthProvider(providerId);
  }
}
