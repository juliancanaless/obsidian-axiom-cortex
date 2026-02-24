import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import { getAccessibleChatModels } from '../../../utils/model-access'

export function ModelSelect() {
  const { settings, setSettings } = useSettings()
  const [isOpen, setIsOpen] = useState(false)

  const enabledChatModels = getAccessibleChatModels(settings)
  const oauthModels = settings.oauthModels || []
  const hasOAuthModels = oauthModels.length > 0
  const hasApiKeyModels = enabledChatModels.length > 0

  // Determine display name for the current model
  const currentOAuthModel = oauthModels.find(m => m.id === settings.chatModelId)
  const displayName = currentOAuthModel
    ? currentOAuthModel.name
    : settings.chatModelId

  return (
    <DropdownMenu.Root open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenu.Trigger className="nrlcmp-chat-input-model-select">
        <div className="nrlcmp-chat-input-model-select__model-name">
          {displayName}
        </div>
        <div className="nrlcmp-chat-input-model-select__icon">
          {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </div>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="nrlcmp-popover">
          <ul>
            {/* Login Models (OAuth) */}
            {hasOAuthModels && (
              <>
                <DropdownMenu.Label asChild>
                  <li className="nrlcmp-popover-group-label">Login Models</li>
                </DropdownMenu.Label>
                {oauthModels.map((model) => (
                  <DropdownMenu.Item
                    key={model.id}
                    onSelect={() => {
                      void setSettings({
                        ...settings,
                        chatModelId: model.id,
                      })
                    }}
                    asChild
                  >
                    <li className={settings.chatModelId === model.id ? 'is-selected' : ''}>
                      {model.name}
                    </li>
                  </DropdownMenu.Item>
                ))}
              </>
            )}

            {/* Separator between groups */}
            {hasOAuthModels && hasApiKeyModels && (
              <DropdownMenu.Separator asChild>
                <li className="nrlcmp-popover-separator" />
              </DropdownMenu.Separator>
            )}

            {/* API Key Models */}
            {hasApiKeyModels && (
              <>
                {hasOAuthModels && (
                  <DropdownMenu.Label asChild>
                    <li className="nrlcmp-popover-group-label">API Key Models</li>
                  </DropdownMenu.Label>
                )}
                {enabledChatModels.map((chatModelOption) => (
                  <DropdownMenu.Item
                    key={chatModelOption.id}
                    onSelect={() => {
                      void setSettings({
                        ...settings,
                        chatModelId: chatModelOption.id,
                      })
                    }}
                    asChild
                  >
                    <li className={settings.chatModelId === chatModelOption.id ? 'is-selected' : ''}>
                      {chatModelOption.id}
                    </li>
                  </DropdownMenu.Item>
                ))}
              </>
            )}
          </ul>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
