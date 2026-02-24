import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice } from 'obsidian'
import { useCallback, useMemo, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { ChatMessage, ChatUserMessage } from '../../types/chat'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { readTFileContent } from '../../utils/obsidian'
import { ResponseGenerator } from '../../utils/chat/responseGenerator'
import { ErrorModal } from '../modals/ErrorModal'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom: () => void
  promptGenerator: PromptGenerator
}

export type UseChatStreamManager = {
  abortActiveStreams: () => void
  submitChatMutation: UseMutationResult<
    void,
    Error,
    { chatMessages: ChatMessage[]; conversationId: string }
  >
}

export function useChatStreamManager({
  setChatMessages,
  autoScrollToBottom,
  promptGenerator,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<AbortController[]>([])

  const abortActiveStreams = useCallback(() => {
    for (const abortController of activeStreamAbortControllersRef.current) {
      abortController.abort()
    }
    activeStreamAbortControllersRef.current = []
  }, [])

  const isOAuthModel = useMemo(() => {
    return (settings.oauthModels || []).some(m => m.id === settings.chatModelId)
  }, [settings.chatModelId, settings.oauthModels])

  const { providerClient, model } = useMemo(() => {
    // OAuth models don't have a provider client — they use Cloud Code Assist
    // Return null sentinel values; the mutation handles this case
    if (isOAuthModel) {
      return { providerClient: null as any, model: null as any }
    }
    try {
      return getChatModelClient({
        settings,
        modelId: settings.chatModelId,
      })
    } catch (error) {
      if (error instanceof LLMModelNotFoundException) {
        if (settings.chatModels.length === 0) {
          throw error
        }
        // Fallback to the first chat model if the selected chat model is not found
        const firstChatModel = settings.chatModels[0]
        // FIX: Handle floating promise from setSettings within useMemo side-effect
        void setSettings({
          ...settings,
          chatModelId: firstChatModel.id,
          chatModels: settings.chatModels.map((model) =>
            model.id === firstChatModel.id
              ? {
                  ...model,
                  enable: true,
                }
              : model,
          ),
        })
        return getChatModelClient({
          settings,
          modelId: firstChatModel.id,
        })
      }
      throw error
    }
  }, [settings, setSettings, isOAuthModel])

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      conversationId,
    }: {
      chatMessages: ChatMessage[]
      conversationId: string
    }) => {
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
        // chatMessages is empty
        return
      }

      abortActiveStreams()
      const abortController = new AbortController()
      activeStreamAbortControllersRef.current.push(abortController)

      let unsubscribeResponseGenerator: (() => void) | undefined

      try {
        // OAuth models: use non-streaming Cloud Code Assist path
        // (Obsidian's requestUrl doesn't support ReadableStream for SSE)
        if (isOAuthModel) {
          const oauthModel = (settings.oauthModels || []).find(m => m.id === settings.chatModelId)
          if (!oauthModel) {
            throw new Error('Selected OAuth model not found. Please select a different model.')
          }

          // Build prompt from the last user message
          const userMessages = chatMessages.filter(m => m.role === 'user')
          const lastUserMsg = userMessages.at(-1)
          let promptText = ''
          if (lastUserMsg && lastUserMsg.role === 'user') {
            if (typeof lastUserMsg.promptContent === 'string') {
              promptText = lastUserMsg.promptContent
            } else if (Array.isArray(lastUserMsg.promptContent)) {
              promptText = lastUserMsg.promptContent
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map(p => p.text)
                .join('\n')
            }
          }

          if (!promptText) {
            throw new Error('No message content to send.')
          }

          // Include current file content if the eye icon is enabled,
          // matching what generateRequestMessages() does for API-key models.
          if (settings.chatOptions.includeCurrentFileContent) {
            const lastUserMessage = chatMessages
              .filter((m): m is ChatUserMessage => m.role === 'user')
              .at(-1)
            const currentFileMentionable = lastUserMessage?.mentionables.find(
              (m) => m.type === 'current-file',
            )
            if (currentFileMentionable?.type === 'current-file' && currentFileMentionable.file) {
              const fileContent = await readTFileContent(
                currentFileMentionable.file,
                app.vault,
              )
              promptText = `# Current File\nHere is the file I'm looking at.\n\`\`\`${currentFileMentionable.file.path}\n${fileContent}\n\`\`\`\n\n${promptText}`
            }
          }

          const responseText = await plugin.simpleLLMCall(promptText)

          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: responseText,
            id: crypto.randomUUID(),
            metadata: {
              model: undefined,
            },
          }

          setChatMessages((prevChatMessages) => {
            const lastMessageIndex = prevChatMessages.findIndex(
              (message) => message.id === lastMessage.id,
            )
            if (lastMessageIndex === -1) {
              return prevChatMessages
            }
            return [
              ...prevChatMessages.slice(0, lastMessageIndex + 1),
              assistantMessage,
            ]
          })
          autoScrollToBottom()
          return
        }

        // Standard API-key path: streaming via ResponseGenerator
        const mcpManager = await getMcpManager()
        const responseGenerator = new ResponseGenerator({
          providerClient,
          model,
          messages: chatMessages,
          conversationId,
          enableTools: settings.chatOptions.enableTools,
          maxAutoIterations: settings.chatOptions.maxAutoIterations,
          promptGenerator,
          mcpManager,
          abortSignal: abortController.signal,
        })

        unsubscribeResponseGenerator = responseGenerator.subscribe(
          (responseMessages) => {
            setChatMessages((prevChatMessages) => {
              const lastMessageIndex = prevChatMessages.findIndex(
                (message) => message.id === lastMessage.id,
              )
              if (lastMessageIndex === -1) {
                // The last message no longer exists in the chat history.
                // This likely means a new message was submitted while this stream was running.
                // Abort this stream and keep the current chat history.
                abortController.abort()
                return prevChatMessages
              }
              return [
                ...prevChatMessages.slice(0, lastMessageIndex + 1),
                ...responseMessages,
              ]
            })
            autoScrollToBottom()
          },
        )

        await responseGenerator.run()
      } catch (error) {
        // Ignore AbortError
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        throw error
      } finally {
        if (unsubscribeResponseGenerator) {
          unsubscribeResponseGenerator()
        }
        activeStreamAbortControllersRef.current =
          activeStreamAbortControllersRef.current.filter(
            (controller) => controller !== abortController,
          )
      }
    },
    onError: (error) => {
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(app, 'Error', error.message, error.rawError?.message, {
          showSettingsButton: true,
        }).open()
      } else {
        new Notice(error.message)
        console.error('Failed to generate response', error)
      }
    },
  })

  return {
    abortActiveStreams,
    submitChatMutation,
  }
}