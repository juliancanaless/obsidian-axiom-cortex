import { App } from 'obsidian'
import NeuralComposerPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'

import { ChatSection } from './sections/ChatSection'
import { EtcSection } from './sections/EtcSection'
import { McpSection } from './sections/McpSection'
import { ModelsSection } from './sections/ModelsSection'
import { OAuthSection } from './sections/OAuthSection'
import { ProvidersSection } from './sections/ProvidersSection'
// import { RAGSection } from './sections/RAGSection' // <--- COMENTADO: Ya no usamos el RAG viejo
import { TemplateSection } from './sections/TemplateSection'
import { NeuralSection } from './sections/NeuralSection' 

type SettingsTabRootProps = {
  app: App
  plugin: NeuralComposerPlugin
}

export function SettingsTabRoot({ app, plugin }: SettingsTabRootProps) {
  return (
    <>
      {/* 1. HEADER & IDENTITY */}
      <div style={{ textAlign: 'center', marginBottom: '30px', marginTop: '10px' }}>
        <h1 style={{ marginBottom: '5px', fontSize: '1.8em' }}>Neural Composer</h1>
        <p style={{ opacity: 0.7, marginTop: '0' }}>Graph-Powered Memory for Obsidian</p>
      </div>

      <ObsidianSetting
        name="About & Support"
        desc="Neural Composer connects Obsidian to a local Knowledge Graph via LightRAG."
        heading
      >
        <ObsidianButton
          text="Original Project (Smart Composer)"
          onClick={() => window.open('https://github.com/glowingjade/obsidian-smart-composer', '_blank')}
        />
      </ObsidianSetting>

      {/* 2. AUTHENTICATION — Two clear sections */}
      {/* API Keys: manual provider configuration */}
      <ProvidersSection app={app} plugin={plugin} />

      {/* Login (OAuth): sign in with existing subscriptions */}
      <OAuthSection app={app} plugin={plugin} />

      {/* 3. MODELS — Shows models from both API Keys and Login */}
      <ModelsSection app={app} plugin={plugin} />

      {/* 4. CEREBRO (LightRAG) */}
      <NeuralSection plugin={plugin} />

      {/* 5. COMPORTAMIENTO (Chat) — Model pickers show both groups */}
      <ChatSection />
      
      {/* 6. HERRAMIENTAS AVANZADAS */}
      <TemplateSection app={app} />
      <McpSection app={app} plugin={plugin} />
      
      {/* 7. ZONA DE PELIGRO / EXTRA */}
      <EtcSection app={app} plugin={plugin} />
    </>
  )
}
