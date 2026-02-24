/**
 * OAuth provider registry and high-level API.
 * Ported from pi-mono/packages/ai/src/utils/oauth/index.ts
 *
 * Adaptations:
 * - Removed http-proxy import
 * - Removed deprecated APIs
 * - Clean re-exports for Obsidian consumption
 */

// Provider implementations
export { anthropicOAuthProvider } from './anthropic'
export { githubCopilotOAuthProvider } from './github-copilot'
export { antigravityOAuthProvider } from './google-antigravity'
export { geminiCliOAuthProvider } from './google-gemini-cli'
export { openaiCodexOAuthProvider } from './openai-codex'

// Types
export * from './types'

// PKCE
export { generatePKCE } from './pkce'

// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from './anthropic'
import { githubCopilotOAuthProvider } from './github-copilot'
import { antigravityOAuthProvider } from './google-antigravity'
import { geminiCliOAuthProvider } from './google-gemini-cli'
import { openaiCodexOAuthProvider } from './openai-codex'
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from './types'

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>([
	[anthropicOAuthProvider.id, anthropicOAuthProvider],
	[githubCopilotOAuthProvider.id, githubCopilotOAuthProvider],
	[geminiCliOAuthProvider.id, geminiCliOAuthProvider],
	[antigravityOAuthProvider.id, antigravityOAuthProvider],
	[openaiCodexOAuthProvider.id, openaiCodexOAuthProvider],
]);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
