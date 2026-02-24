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

    container.createEl('h3', { text: 'OAuth Authentication' })
    container.createEl('p', {
      text: 'Login with your existing AI subscriptions to get API tokens automatically. This is an alternative to manual API keys.',
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

    // Provider status table
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

    // Login button
    new Setting(container)
      .setName('Login to a provider')
      .setDesc('Authenticate with an OAuth provider to get API tokens automatically.')
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
