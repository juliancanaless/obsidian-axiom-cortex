import {
  RECOMMENDED_MODELS_FOR_APPLY,
  RECOMMENDED_MODELS_FOR_CHAT,
} from '../../../constants'
import { useSettings } from '../../../contexts/settings-context'
import { getAccessibleChatModels } from '../../../utils/model-access'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function ChatSection() {
  const { settings, setSettings } = useSettings()

  const enabledChatModels = getAccessibleChatModels(settings)
  const oauthModels = settings.oauthModels || []

  // Build combined options: OAuth models first (labeled), then API key models
  const buildModelOptions = () => {
    const options: Record<string, string> = {}

    // OAuth models first
    for (const model of oauthModels) {
      options[model.id] = `${model.name} (Login)`
    }

    // API key models
    for (const chatModel of enabledChatModels) {
      const suffix = RECOMMENDED_MODELS_FOR_CHAT.includes(chatModel.id)
        ? ' (Recommended)'
        : oauthModels.length > 0
          ? ' (API Key)'
          : ''
      options[chatModel.id] = `${chatModel.id}${suffix}`
    }

    return options
  }

  const buildApplyModelOptions = () => {
    const options: Record<string, string> = {}

    // OAuth models first
    for (const model of oauthModels) {
      options[model.id] = `${model.name} (Login)`
    }

    // API key models
    for (const chatModel of enabledChatModels) {
      const suffix = RECOMMENDED_MODELS_FOR_APPLY.includes(chatModel.id)
        ? ' (Recommended)'
        : oauthModels.length > 0
          ? ' (API Key)'
          : ''
      options[chatModel.id] = `${chatModel.id}${suffix}`
    }

    return options
  }

  return (
    <div className="nrlcmp-settings-section">
      <div className="nrlcmp-settings-header">Chat</div>

      <ObsidianSetting
        name="Chat model"
        desc="Choose the model you want to use for chat."
      >
        <ObsidianDropdown
          value={settings.chatModelId}
          options={buildModelOptions()}
          onChange={(value) => {
            void setSettings({
              ...settings,
              chatModelId: value,
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name="Apply model"
        desc="Choose the model you want to use for apply feature."
      >
        <ObsidianDropdown
          value={settings.applyModelId}
          options={buildApplyModelOptions()}
          onChange={(value) => {
            void setSettings({
              ...settings,
              applyModelId: value,
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name="System prompt"
        desc="This prompt will be added to the beginning of every chat."
        className="nrlcmp-settings-textarea-header"
      />

      <ObsidianSetting className="nrlcmp-settings-textarea">
        <ObsidianTextArea
          value={settings.systemPrompt}
          onChange={(value: string) => {
            void setSettings({
              ...settings,
              systemPrompt: value,
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name="Include current file"
        desc="Automatically include the content of your current file in chats."
      >
        <ObsidianToggle
          value={settings.chatOptions.includeCurrentFileContent}
          onChange={(value) => {
            void setSettings({
              ...settings,
              chatOptions: {
                ...settings.chatOptions,
                includeCurrentFileContent: value,
              },
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name="Enable tools"
        desc="Allow the AI to use MCP tools."
      >
        <ObsidianToggle
          value={settings.chatOptions.enableTools}
          onChange={(value) => {
            void setSettings({
              ...settings,
              chatOptions: {
                ...settings.chatOptions,
                enableTools: value,
              },
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name="Max auto tool requests"
        desc="Maximum number of consecutive tool calls that can be made automatically without user confirmation. Higher values can significantly increase costs as each tool call consumes additional tokens."
      >
        <ObsidianTextInput
          value={settings.chatOptions.maxAutoIterations.toString()}
          onChange={(value) => {
            const parsedValue = parseInt(value)
            if (isNaN(parsedValue) || parsedValue < 1) {
              return
            }
            void setSettings({
              ...settings,
              chatOptions: {
                ...settings.chatOptions,
                maxAutoIterations: parsedValue,
              },
            })
          }}
        />
      </ObsidianSetting>
    </div>
  )
}
