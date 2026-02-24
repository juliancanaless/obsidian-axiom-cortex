import { App } from 'obsidian'
import React, { useEffect, useRef, useState } from 'react'
import { Setting, ButtonComponent } from 'obsidian'
import NeuralComposerPlugin from '../../../main'

type OAuthSectionProps = {
  app: App
  plugin: NeuralComposerPlugin
}

export function OAuthSection({ app, plugin }: OAuthSectionProps) {
  const settingsRef = useRef<HTMLDivElement>(null)
  const [, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!settingsRef.current) return
    const container = settingsRef.current
    container.empty()

    container.createEl('h3', { text: 'Login (OAuth)' })
    container.createEl('p', {
      text: 'Sign in with your existing AI subscriptions. No API keys needed — models are unlocked automatically.',
      cls: 'setting-item-description',
    })

    // Check if oauthManager exists
    if (!plugin.oauthManager) {
      container.createEl('p', {
        text: 'OAuth system not initialized. Please restart Obsidian.',
        cls: 'mod-warning',
      })
      return
    }

    const providers = plugin.oauthManager.listProviders()

    // Provider status
    for (const provider of providers) {
      const setting = new Setting(container)
        .setName(provider.name)

      if (provider.loggedIn) {
        const descParts = ['✓ Logged in']
        if (provider.email) descParts.push(`(${provider.email})`)
        if (provider.expires) {
          const expiresDate = new Date(provider.expires)
          descParts.push(`· Expires: ${expiresDate.toLocaleString()}`)
        }
        setting.setDesc(descParts.join(' '))

        setting.addButton((btn) =>
          btn
            .setButtonText('Logout')
            .setWarning()
            .onClick(() => {
              void (async () => {
                await plugin.oauthManager!.logout(provider.id)
                setRefreshKey((k) => k + 1)
              })()
            }),
        )
      } else {
        setting.setDesc('Not logged in')
      }
    }

    // Show discovered models for logged-in providers
    const oauthModels = plugin.settings.oauthModels || []
    if (oauthModels.length > 0) {
      const modelsContainer = container.createDiv({ cls: 'setting-item' })
      modelsContainer.createEl('div', {
        text: 'Models from Login:',
        cls: 'setting-item-name',
      })
      const modelsList = modelsContainer.createEl('div', {
        cls: 'setting-item-description',
      })
      // Group models by provider
      const byProvider = new Map<string, typeof oauthModels>()
      for (const model of oauthModels) {
        const existing = byProvider.get(model.oauthProviderId) || []
        existing.push(model)
        byProvider.set(model.oauthProviderId, existing)
      }
      for (const [, models] of byProvider) {
        const list = modelsList.createEl('ul', {
          attr: { style: 'margin: 4px 0; padding-left: 20px; opacity: 0.8;' },
        })
        for (const model of models) {
          list.createEl('li', { text: model.name })
        }
      }
    }

    // Login button
    new Setting(container)
      .setName('Login to a provider')
      .setDesc('Authenticate with an OAuth provider to unlock models automatically.')
      .addButton((btn) =>
        btn
          .setButtonText('Login')
          .setCta()
          .onClick(() => {
            plugin.oauthManager!.showLoginSelector('login')
          }),
      )

  }, [plugin, setRefreshKey])

  return <div ref={settingsRef} />
}
