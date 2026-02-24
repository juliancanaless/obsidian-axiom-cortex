/**
 * OAuthLoginModal — Obsidian Modal for OAuth provider selection and login flow.
 * 
 * Two modes:
 * - 'login': Show provider list, user selects one, runs auth flow
 * - 'logout': Show logged-in providers, user selects one to logout
 * 
 * For each provider type, the modal adapts its UI:
 * - Callback server providers: Show URL + "Waiting..." + manual paste fallback
 * - Anthropic: Show URL + paste field for code#state
 * - GitHub Copilot: Show verification URL + user code + polling status
 */

import { App, Modal, ButtonComponent, Notice } from 'obsidian'
import type { OAuthManager, OAuthProviderStatus } from '../../auth/OAuthManager'
import type { OAuthCredentials } from '../../auth/oauth/types'

export class OAuthLoginModal extends Modal {
  private oauthManager: OAuthManager;
  private mode: 'login' | 'logout';
  private abortController: AbortController;

  constructor(app: App, oauthManager: OAuthManager, mode: 'login' | 'logout') {
    super(app);
    this.oauthManager = oauthManager;
    this.mode = mode;
    this.abortController = new AbortController();
  }

  onOpen() {
    if (this.mode === 'login') {
      this.renderProviderSelector();
    } else {
      this.renderLogoutSelector();
    }
  }

  onClose() {
    this.abortController.abort();
    this.contentEl.empty();
  }

  // ========================================================================
  // Login: Provider Selector
  // ========================================================================

  private renderProviderSelector() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Login to OAuth Provider' });
    contentEl.createEl('p', {
      text: 'Select a provider to authenticate with. Your subscription tokens will be used for LightRAG queries.',
      cls: 'setting-item-description',
    });

    const providers = this.oauthManager.listProviders();
    const listEl = contentEl.createDiv({ cls: 'nrlcmp-oauth-provider-list' });

    for (const provider of providers) {
      const itemEl = listEl.createDiv({ cls: 'nrlcmp-oauth-provider-item' });
      itemEl.setCssProps({ 
        'display': 'flex', 
        'justify-content': 'space-between', 
        'align-items': 'center',
        'padding': '8px 12px',
        'border': '1px solid var(--background-modifier-border)',
        'border-radius': '6px',
        'margin-bottom': '6px',
        'cursor': 'pointer',
      });

      const infoEl = itemEl.createDiv();
      const nameEl = infoEl.createEl('strong', { text: provider.name });
      
      if (provider.loggedIn) {
        const statusEl = infoEl.createEl('span', { text: ' ✓' });
        statusEl.setCssProps({ color: 'var(--text-success)', 'margin-left': '6px' });
        if (provider.email) {
          infoEl.createEl('div', { 
            text: provider.email, 
            cls: 'setting-item-description' 
          });
        }
      }

      const btnEl = itemEl.createDiv();
      new ButtonComponent(btnEl)
        .setButtonText(provider.loggedIn ? 'Re-login' : 'Login')
        .setCta()
        .onClick(() => {
          void this.startLoginFlow(provider);
        });
    }

    // Cancel button
    const footerEl = contentEl.createDiv();
    footerEl.setCssProps({ 'margin-top': '16px', 'text-align': 'right' });
    new ButtonComponent(footerEl)
      .setButtonText('Cancel')
      .onClick(() => this.close());
  }

  // ========================================================================
  // Login: Auth Flow
  // ========================================================================

  private async startLoginFlow(provider: OAuthProviderStatus) {
    const { contentEl } = this;
    contentEl.empty();
    
    // Reset abort controller for this flow
    this.abortController = new AbortController();

    contentEl.createEl('h3', { text: `Logging in to ${provider.name}` });

    const statusEl = contentEl.createDiv({ cls: 'nrlcmp-oauth-status' });
    statusEl.setCssProps({ 'margin': '12px 0' });
    statusEl.setText('Initializing...');

    // Manual code input container (shown for callback server providers + anthropic)
    const manualContainer = contentEl.createDiv({ cls: 'nrlcmp-oauth-manual' });
    manualContainer.setCssProps({ 'display': 'none', 'margin-top': '16px' });

    // Cancel button
    const footerEl = contentEl.createDiv();
    footerEl.setCssProps({ 'margin-top': '16px', 'text-align': 'right' });
    new ButtonComponent(footerEl)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    // Resolve helpers for manual input
    let manualResolve: ((value: string) => void) | null = null;
    let promptResolve: ((value: string) => void) | null = null;

    const providerImpl = this.oauthManager.getProvider(provider.id);

    try {
      const credentials = await this.oauthManager.login(provider.id, {
        onAuth: (info) => {
          // Show URL to user and auto-open browser
          statusEl.empty();
          if (info.instructions) {
            statusEl.createEl('p', { text: info.instructions });
          }

          const urlContainer = statusEl.createDiv();
          urlContainer.setCssProps({ 'margin': '8px 0' });
          const urlLink = urlContainer.createEl('a', {
            text: info.url.length > 80 ? info.url.substring(0, 80) + '...' : info.url,
            href: info.url,
          });
          urlLink.setCssProps({ 'word-break': 'break-all', 'font-size': '0.85em' });

          // Auto-open browser
          window.open(info.url);

          statusEl.createEl('p', { text: 'Waiting for authentication...' });
        },

        onPrompt: (prompt) => {
          return new Promise<string>((resolve) => {
            promptResolve = resolve;
            
            // Show input field in the modal
            const promptContainer = contentEl.createDiv();
            promptContainer.setCssProps({ 'margin-top': '12px' });
            promptContainer.createEl('label', { text: prompt.message });
            
            const inputEl = promptContainer.createEl('input', { type: 'text' });
            inputEl.setCssProps({ 'width': '100%', 'margin-top': '4px' });
            if (prompt.placeholder) inputEl.placeholder = prompt.placeholder;
            
            // For allowEmpty prompts, add a Skip button
            if (prompt.allowEmpty) {
              const skipBtnContainer = promptContainer.createDiv();
              skipBtnContainer.setCssProps({ 'margin-top': '6px' });
              new ButtonComponent(skipBtnContainer)
                .setButtonText('Skip (use default)')
                .onClick(() => {
                  resolve('');
                  promptContainer.remove();
                });
            }

            const submitContainer = promptContainer.createDiv();
            submitContainer.setCssProps({ 'margin-top': '6px' });
            new ButtonComponent(submitContainer)
              .setButtonText('Submit')
              .setCta()
              .onClick(() => {
                resolve(inputEl.value);
                promptContainer.remove();
              });

            // Also submit on Enter
            inputEl.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                resolve(inputEl.value);
                promptContainer.remove();
              }
            });

            inputEl.focus();
          });
        },

        onProgress: (message) => {
          const progressEl = statusEl.createEl('p', { text: message });
          progressEl.setCssProps({ 'opacity': '0.7', 'font-size': '0.9em' });
        },

        onManualCodeInput: providerImpl?.usesCallbackServer ? () => {
          return new Promise<string>((resolve) => {
            manualResolve = resolve;
            
            // Show manual paste fallback
            manualContainer.setCssProps({ 'display': 'block' });
            manualContainer.empty();
            manualContainer.createEl('p', { 
              text: 'If the browser callback didn\'t work, paste the redirect URL here:',
              cls: 'setting-item-description',
            });
            
            const inputEl = manualContainer.createEl('input', { type: 'text' });
            inputEl.setCssProps({ 'width': '100%', 'margin-top': '4px' });
            inputEl.placeholder = 'http://localhost:.../callback?code=...';
            
            const submitContainer = manualContainer.createDiv();
            submitContainer.setCssProps({ 'margin-top': '6px' });
            new ButtonComponent(submitContainer)
              .setButtonText('Submit URL')
              .onClick(() => {
                resolve(inputEl.value);
              });

            inputEl.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                resolve(inputEl.value);
              }
            });
          });
        } : undefined,

        signal: this.abortController.signal,
      });

      // Success!
      this.renderLoginSuccess(provider, credentials);

    } catch (error) {
      if (this.abortController.signal.aborted) {
        // User cancelled — modal is closing, nothing to show
        return;
      }
      
      const message = error instanceof Error ? error.message : String(error);
      statusEl.empty();
      statusEl.createEl('p', { 
        text: `Login failed: ${message}`, 
        cls: 'mod-warning' 
      });
      new Notice(`OAuth login failed: ${message}`);
    }
  }

  private renderLoginSuccess(provider: OAuthProviderStatus, credentials: OAuthCredentials) {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Login Successful!' });
    
    const infoEl = contentEl.createDiv();
    infoEl.setCssProps({ 'margin': '12px 0' });
    infoEl.createEl('p', { text: `✓ Logged in to ${provider.name}` });
    
    if (credentials.email) {
      infoEl.createEl('p', { text: `Account: ${credentials.email as string}` });
    }
    if (credentials.projectId) {
      infoEl.createEl('p', { 
        text: `Project: ${credentials.projectId as string}`,
        cls: 'setting-item-description',
      });
    }

    const footerEl = contentEl.createDiv();
    footerEl.setCssProps({ 'margin-top': '16px', 'text-align': 'right' });
    new ButtonComponent(footerEl)
      .setButtonText('Done')
      .setCta()
      .onClick(() => this.close());
  }

  // ========================================================================
  // Logout: Provider Selector
  // ========================================================================

  private renderLogoutSelector() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Logout from OAuth Provider' });

    const providers = this.oauthManager.listProviders().filter((p) => p.loggedIn);

    if (providers.length === 0) {
      contentEl.createEl('p', { text: 'No providers are currently logged in.' });
      const footerEl = contentEl.createDiv();
      footerEl.setCssProps({ 'margin-top': '16px', 'text-align': 'right' });
      new ButtonComponent(footerEl)
        .setButtonText('Close')
        .onClick(() => this.close());
      return;
    }

    const listEl = contentEl.createDiv({ cls: 'nrlcmp-oauth-provider-list' });

    for (const provider of providers) {
      const itemEl = listEl.createDiv({ cls: 'nrlcmp-oauth-provider-item' });
      itemEl.setCssProps({
        'display': 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        'padding': '8px 12px',
        'border': '1px solid var(--background-modifier-border)',
        'border-radius': '6px',
        'margin-bottom': '6px',
      });

      const infoEl = itemEl.createDiv();
      infoEl.createEl('strong', { text: provider.name });
      if (provider.email) {
        infoEl.createEl('div', {
          text: provider.email,
          cls: 'setting-item-description',
        });
      }

      const btnEl = itemEl.createDiv();
      new ButtonComponent(btnEl)
        .setButtonText('Logout')
        .setWarning()
        .onClick(() => {
          void (async () => {
            await this.oauthManager.logout(provider.id);
            // Refresh the list
            this.renderLogoutSelector();
          })();
        });
    }

    const footerEl = contentEl.createDiv();
    footerEl.setCssProps({ 'margin-top': '16px', 'text-align': 'right' });
    new ButtonComponent(footerEl)
      .setButtonText('Close')
      .onClick(() => this.close());
  }
}
