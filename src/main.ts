import { Plugin, Notice, requestUrl, Editor, MarkdownView, TFile, TFolder, WorkspaceLeaf, setTooltip } from 'obsidian';
import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { NativeGraphView, NATIVE_GRAPH_VIEW_TYPE } from './views/NativeGraphView';

import { ApplyView } from './ApplyView';
import { ChatView } from './ChatView';
import { ChatProps } from './components/chat-view/Chat';
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants';
import { McpManager } from './core/mcp/mcpManager';
import { RAGEngine } from './core/rag/ragEngine';
import { DatabaseManager } from './database/DatabaseManager';
import {
  NeuralComposerSettings,
  NeuralComposerSettingsSchema,
} from './settings/schema/setting.types';
import { parseNeuralComposerSettings } from './settings/schema/settings';
import { NeuralComposerSettingTab } from './settings/SettingTab';
import { getMentionableBlockData } from './utils/obsidian';
import { VectorManager } from './database/modules/vector/VectorManager';
import { OAuthManager } from './auth/OAuthManager';

export const PLUGIN_NAME = "Neural Composer";
export const BACKEND_NAME = "LightRAG";
export const TERM_API = 'API';
export const TERM_LLM = 'LLM';
export const TERM_LLM_EMBED = 'LLM/Embed';
export const VAR_MAX_ASYNC = 'MAX_ASYNC'; // Nombre de variable de entorno/configuración

// --- MASTER EXTENSION LIST ---
const SUPPORTED_EXTENSIONS = [
    'md', 'txt', 'docx', 'pdf', 'pptx', 'xlsx', 'rtf', 'odt', 'epub',
    'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'csv',
    'tex', 'log', 'conf', 'ini', 'properties', 'sql', 'bat', 'sh', 
    'c', 'cpp', 'py', 'java', 'js', 'ts', 'swift', 'go', 'rb', 'php',
    'css', 'scss', 'less'
];

const TEXT_BASED_EXTENSIONS = [
    'md', 'txt', 'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'csv', 
    'tex', 'log', 'conf', 'ini', 'properties', 'sql', 'bat', 'sh', 
    'c', 'cpp', 'py', 'java', 'js', 'ts', 'swift', 'go', 'rb', 'php', 
    'css', 'scss', 'less'
];

// Definition for internal use, as 'Adapter' is not exported directly
interface FileSystemAdapterWithBasePath {
    getBasePath: () => string;
}

export default class NeuralComposerPlugin extends Plugin {
  settings: NeuralComposerSettings;
  initialChatProps?: ChatProps;
  settingsChangeListeners: ((newSettings: NeuralComposerSettings) => void)[] = [];
  mcpManager: McpManager | null = null;
  dbManager: DatabaseManager | null = null;
  ragEngine: RAGEngine | null = null;
  oauthManager: OAuthManager;
  
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null;
  private ragEngineInitPromise: Promise<RAGEngine> | null = null;
  
  private timeoutIds: ReturnType<typeof setTimeout>[] = [];
  private serverProcess: ChildProcess | null = null;
  private lastErrorTime: number = 0; 

  // --- STATUS BAR PROPERTIES ---
  private statusBarEl: HTMLElement;
  private statusDotEl: HTMLElement;
  private heartbeatInterval: number;

  async onload() {
    await this.loadSettings();

    // --- ZERO-CONFIG & PORTABILITY ---
    if (!this.settings.lightRagWorkDir) {
        // Safe casting to check for desktop adapter capabilities
        const adapter = this.app.vault.adapter;
        
        // FIX: Cast to unknown then to the specific interface to avoid 'any'
        // This satisfies the linter while checking for the desktop-only method
        if (typeof (adapter as unknown as FileSystemAdapterWithBasePath).getBasePath === 'function') { 
            const vaultRoot = (adapter as unknown as FileSystemAdapterWithBasePath).getBasePath();
            const defaultPath = path.join(vaultRoot, '.neural_memory');
            
            if (!fs.existsSync(defaultPath)) {
                try {
                    fs.mkdirSync(defaultPath, { recursive: true });
                } catch (e) {
                    console.error("Failed to create default folder:", e);
                    new Notice("Failed to create default .neural_memory folder.");
                }
            }
            
            this.settings.lightRagWorkDir = defaultPath;
            await this.saveData(this.settings);
        }
    }
    
// --- STATUS BAR INITIALIZATION ---
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('nrlcmp-status-bar-item');
    this.statusDotEl = this.statusBarEl.createSpan({ cls: 'nrlcmp-status-dot' });
    this.statusBarEl.createSpan({ text: 'Neural' });
    setTooltip(this.statusBarEl, `${BACKEND_NAME} server status`);
    
    this.statusBarEl.onclick = () => {
        void this.handleStatusBarClick();
    };

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf));
    
    this.addRibbonIcon('brain-circuit', `Open ${PLUGIN_NAME}`, () => {
        void this.openChatView();
    });

    // NATIVE GRAPH VIEWER
    this.registerView(
      NATIVE_GRAPH_VIEW_TYPE,
      (leaf) => new NativeGraphView(leaf, this)
    );

    this.addCommand({
      id: 'open-native-graph',
      name: 'Open native graph view',
      callback: () => {
        // Wrapped in void async IIFE to satisfy void return expectation
        void (async () => {
            const { workspace } = this.app;
            let leaf: WorkspaceLeaf | null = null;
            const leaves = workspace.getLeavesOfType(NATIVE_GRAPH_VIEW_TYPE);

            if (leaves.length > 0) {
              leaf = leaves[0];
            } else {
              leaf = workspace.getLeaf(true);
              await leaf.setViewState({ type: NATIVE_GRAPH_VIEW_TYPE, active: true });
            }
            if (leaf) await workspace.revealLeaf(leaf);
        })();
      },
    });

    this.addCommand({
      id: 'open-new-chat',
      name: 'Open chat',
      callback: () => { void this.openChatView(true); },
    });

    this.addCommand({
      id: 'add-selection-to-chat',
      name: 'Add selection to chat',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.addSelectionToChat(editor, view);
      },
    });

    // --- QUICK RESTART COMMAND ---
    this.addCommand({
      id: 'restart-neural-backend',
      name: `Restart neural backend (${BACKEND_NAME})`,
      callback: () => {
        this.restartLightRagServer();
      },
    });

    // --- CONTEXT MENU (FOLDERS) ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Ingest folder into graph')
              .setIcon('layers')
              .onClick(() => {
                void this.batchIngestFolder(file);
              });
          });
        }
      })
    );

    // --- SINGLE FILE INGEST COMMAND ---
    this.addCommand({
      id: 'ingest-current-file',
      name: 'Ingest current file into knowledge graph',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())) {
            return false;
        }
        if (checking) return true;

        // IIFE to handle async in callback safely
        void (async () => {
            const title = file.basename;
            const ext = file.extension.toLowerCase();
            const notice = new Notice(`Sending "${file.name}" to the system...`, 0);

            try {
                const ragEngine = await this.getRAGEngine();
                let success = false;
                
                if (TEXT_BASED_EXTENSIONS.includes(ext)) {
                     const content = await this.app.vault.read(file);
                     const finalContent = ext === 'md' ? `Title: ${title}\n\n${content}` : content;
                     success = await ragEngine.insertDocument(finalContent, file.name);
                } else {
                     success = await ragEngine.uploadDocument(file);
                }

                if (success) {
                    notice.setMessage(`Sent. Processing in background...`);
                    await this.monitorPipeline(notice);
                } else {
                    notice.setMessage(`Upload failed.`);
                    setTimeout(() => notice.hide(), 5000);
                }
            } catch (error) {
                console.error(error);
                notice.setMessage(`Critical error connecting to backend.`);
                setTimeout(() => notice.hide(), 5000);
            }
        })();
      },
    });

    this.addSettingTab(new NeuralComposerSettingTab(this.app, this));

    // --- OAUTH MANAGER ---
    this.oauthManager = new OAuthManager(this);

    this.addCommand({
      id: 'oauth-login',
      name: 'Login to OAuth provider',
      callback: () => { this.oauthManager.showLoginSelector('login'); },
    });

    this.addCommand({
      id: 'oauth-logout',
      name: 'Logout from OAuth provider',
      callback: () => { this.oauthManager.showLoginSelector('logout'); },
    });

    // --- SYNTHESIS COMMANDS ---
    this.addCommand({
      id: 'synthesize-note',
      name: 'Synthesize: Create cohesive note from graph context',
      callback: () => void this.runSynthesis(),
    });

    this.addCommand({
      id: 'contextual-suggestion',
      name: 'Suggest: Find connecting evidence for selection',
      editorCallback: (editor) => {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mdView) void this.contextualSuggest(editor, mdView);
      },
    });

    this.addCommand({
      id: 'folder-synthesis',
      name: 'Synthesize: Multi-folder distillation',
      callback: () => void this.folderSynthesis(),
    });

    this.addCommand({
      id: 'proactive-links',
      name: 'Toggle: Proactive link discovery',
      callback: () => {
        const newValue = !this.settings.enableProactiveDiscovery;
        void this.setSettings({ ...this.settings, enableProactiveDiscovery: newValue });
        new Notice(`Proactive discovery ${newValue ? 'enabled' : 'disabled'}`);
      },
    });

    // --- OAUTH PROTOCOL HANDLER (fallback for callback servers) ---
    this.registerObsidianProtocolHandler('axiom-cortex/oauth-callback', async (params) => {
      // This handles obsidian://axiom-cortex/oauth-callback?code=...&state=...
      // It's a fallback — the primary flow uses local HTTP servers
      console.log('[Axiom Cortex] Received OAuth callback via protocol handler:', params);
    });

    // --- CONTEXT MENU (EDITOR) ---
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        if (editor.getSelection()) {
          menu.addItem((item) => {
            item.setTitle('Axiom: Find connecting evidence')
                .setIcon('git-merge')
                .onClick(() => {
                  const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
                  if (mdView) void this.contextualSuggest(editor, mdView);
                });
          });
          menu.addItem((item) => {
            item.setTitle('Axiom: Synthesize from selection')
                .setIcon('sparkles')
                .onClick(() => void this.runSynthesis(editor.getSelection()));
          });
        }
      })
    );

    // --- AGGRESSIVE AUTO-START ---
this.app.workspace.onLayoutReady(() => {
        if (this.settings.enableAutoStartServer) {
            void this.startLightRagServer();
        }
        // --- LATIDO LEGAL Y SEGURO ---
        // registerInterval asegura que el proceso muera si el plugin se apaga
        this.registerInterval(window.setInterval(() => {
            void this.checkAndUpdateStatus();
        }, 30000));

        // --- OAUTH TOKEN REFRESH (every 15 min) ---
        this.registerInterval(window.setInterval(() => {
            void this.oauthManager.refreshAllIfNeeded();
        }, 15 * 60 * 1000));

        // --- PROACTIVE DISCOVERY ---
        if (this.settings.enableProactiveDiscovery) {
            this.startProactiveDiscovery();
        }
        
        // Primera revisión inmediata
        void this.checkAndUpdateStatus();
    });
  }

  // --- MONITORING LOGIC ---
  async monitorPipeline(notice: Notice) {
    this.updateStatusUI('busy');
    let isBusy = true;
    let errors = 0;
    // Wait for server to register task
    await new Promise(r => setTimeout(r, 1000));

    while (isBusy) {
        try {
            const response = await requestUrl({
                url: "http://localhost:9621/documents/pipeline_status",
                method: "GET"
            });
            
            const status = response.json;
            isBusy = status.busy;
            
            if (isBusy) {
                const total = status.batchs || 1;
                const current = status.cur_batch || 0;
                const percent = Math.round((current / total) * 100);
                
                notice.setMessage(
                    `System processing...\n` +
                    `Progress: ${percent}% (${current}/${total})\n` +
                    `📝 ${status.latest_message || "Analyzing..."}`
                );
            }

            if (!isBusy) break;

            await new Promise(r => setTimeout(r, 1500)); // Polling 1.5s

        } catch { 
            // Fix: Use empty catch block to avoid unused variable '_' warning
            errors++;
            if (errors > 3) isBusy = false;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    this.updateStatusUI('online');
    notice.setMessage("Integrated knowledge!\nThe graph is up to date.");
    setTimeout(() => notice.hide(), 5000);
  }

  // --- BATCH LOGIC ---
  private getAllSupportedFiles(folder: TFolder): TFile[] {
    let files: TFile[] = [];
    for (const child of folder.children) {
        if (child instanceof TFile) {
            if (SUPPORTED_EXTENSIONS.includes(child.extension.toLowerCase())) {
                files.push(child);
            }
        } else if (child instanceof TFolder) {
            files = files.concat(this.getAllSupportedFiles(child));
        }
    }
    return files;
  }

  async batchIngestFolder(folder: TFolder) {
    const files = this.getAllSupportedFiles(folder);
    if (files.length === 0) {
        new Notice("Empty folder or no supported files.");
        return;
    }

    const notice = new Notice(`📦 Sending ${files.length} files to system...`, 0);
    
    try {
        const ragEngine = await this.getRAGEngine();
        let successCount = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ext = file.extension.toLowerCase();
            
            notice.setMessage(`📦 Sending (${i + 1}/${files.length}):\n📄 ${file.name}`);
            
            try {
                let result = false;
                if (TEXT_BASED_EXTENSIONS.includes(ext)) {
                    const content = await this.app.vault.read(file);
                    const finalContent = ext === 'md' ? `Title: ${file.basename}\n\n${content}` : content;
                    result = await ragEngine.insertDocument(finalContent, file.name);
                } else {
                    result = await ragEngine.uploadDocument(file);
                }
                
                if (result) successCount++;
                await new Promise(resolve => setTimeout(resolve, 200)); 

            } catch (err) {
                console.error(`Error processing ${file.name}:`, err);
            }
        }

        notice.setMessage(`Uploaded files (${successCount}).\nStart processing...`);
        await this.monitorPipeline(notice);

    } catch (error) {
        console.error("Batch error:", error);
        notice.setMessage("Error starting upload.");
        setTimeout(() => notice.hide(), 5000);
    }
  }

  // --- LIFECYCLE & SERVER MANAGEMENT ---
  
onunload() {
    window.clearInterval(this.heartbeatInterval);
    this.timeoutIds.forEach((id) => clearTimeout(id));
    this.timeoutIds = [];
    
    if (this.ragEngine) {
        this.ragEngine.cleanup();
        this.ragEngine = null;
    }
    
    // Reset promises so they can be re-initialized if plugin is re-enabled without full reload
    this.dbManagerInitPromise = null;
    this.ragEngineInitPromise = null;
    
    if (this.dbManager) {
        // FIX: Use void operator to handle the async cleanup promise
        void this.dbManager.cleanup();
        this.dbManager = null;
    }
    if (this.mcpManager) {
        // FIX: Use void operator here too if mcpManager.cleanup() is async
        void this.mcpManager.cleanup();
        this.mcpManager = null;
    }
    this.stopLightRagServer();
  }

  public stopLightRagServer() {
    if (this.serverProcess) {
        this.serverProcess.kill();
        this.serverProcess = null;
    }
    try {
        if (process.platform === 'win32') {
            // Force kill tree
            execSync('taskkill /F /IM lightrag-server.exe /T', { stdio: 'ignore' });
        }
    } catch {
        // Ignore kill errors if process not found
    }
    this.updateStatusUI('offline');  
}

  public restartLightRagServer() {
    new Notice("Restarting system backend...");
    this.stopLightRagServer();
    // Use timeout to allow process to fully die
    this.timeoutIds.push(setTimeout(() => {
        this.updateEnvFile();
        void this.startLightRagServer();
    }, 2000));
  }

  // GENERATOR
  public generateEnvConfig(): string {
    const workDir = this.settings.lightRagWorkDir;
    if (!workDir) return "";

    try {
        const targetLlmId = this.settings.lightRagModelId || this.settings.chatModelId;
        const embeddingId = this.settings.lightRagEmbeddingModelId || this.settings.embeddingModelId;
        
        const llmModelObj = this.settings.chatModels.find(m => m.id === targetLlmId);
        const embedModelObj = this.settings.embeddingModels.find(m => m.id === embeddingId);

        const llmProvider = this.settings.providers.find(p => p.id === llmModelObj?.providerId);
        const embedProvider = this.settings.providers.find(p => p.id === embedModelObj?.providerId);

        let envContent = `# Generated by Neural Composer\n`;
        envContent += `# You can edit this file manually before restarting.\n\n`;
        
        envContent += `WORKING_DIR=${workDir}\n`;
        envContent += `HOST=0.0.0.0\n`;
        envContent += `PORT=9621\n`;
        envContent += `SUMMARY_LANGUAGE=${this.settings.lightRagSummaryLanguage || 'English'}\n`;
        
        // --- TUNING VARS ---
        envContent += `\n# --- Performance Tuning ---\n`;
        envContent += `MAX_ASYNC=${this.settings.lightRagMaxAsync}\n`;
        envContent += `MAX_PARALLEL_INSERT=${this.settings.lightRagMaxParallelInsert}\n`;
        envContent += `CHUNK_SIZE=${this.settings.lightRagChunkSize}\n`;
        envContent += `CHUNK_OVERLAP_SIZE=${this.settings.lightRagChunkOverlap}\n\n`;

        // LLM
        if (llmModelObj && llmProvider) {
            envContent += `# LLM Configuration\n`;
            envContent += `LLM_BINDING=${llmProvider.id}\n`;
            envContent += `LLM_MODEL=${llmModelObj.model}\n`;
            if (llmProvider.id === 'ollama' && llmProvider.baseUrl) envContent += `OLLAMA_HOST=${llmProvider.baseUrl}\n`;
            else if (llmProvider.id === 'openai' && llmProvider.baseUrl?.includes('localhost')) envContent += `OPENAI_BASE_URL=${llmProvider.baseUrl}\n`;
        }

        // Embeddings
        if (embedModelObj && embedProvider) {
            envContent += `\n# Embedding Configuration\n`;
            envContent += `EMBEDDING_BINDING=${embedProvider.id}\n`;
            envContent += `EMBEDDING_MODEL=${embedModelObj.model}\n`;
            envContent += `EMBEDDING_DIM=${embedModelObj.dimension || 1024}\n`;
            envContent += `MAX_TOKEN_SIZE=8192\n`;
        }

        // RERANKING
        const rerankSelection = this.settings.lightRagRerankBinding;
        
        if (rerankSelection && rerankSelection !== '') {
            envContent += `\n# Reranking Configuration\n`;
            
            let realBindingName = rerankSelection;
            
            if (rerankSelection === 'custom') {
                 realBindingName = this.settings.lightRagRerankBindingType || 'cohere';
                 envContent += `RERANK_BINDING_HOST=${this.settings.lightRagRerankHost}\n`;
            } else {
                 if (rerankSelection === 'jina') envContent += `RERANK_BINDING_HOST=https://api.jina.ai/v1/rerank\n`;
                 if (rerankSelection === 'cohere') envContent += `RERANK_BINDING_HOST=https://api.cohere.com/v2/rerank\n`;
            }

            envContent += `RERANK_BINDING=${realBindingName}\n`;
            envContent += `RERANK_MODEL=${this.settings.lightRagRerankModel}\n`;
            if (this.settings.lightRagRerankApiKey) {
                envContent += `RERANK_BINDING_API_KEY=${this.settings.lightRagRerankApiKey}\n`;
            }
        } else {
             envContent += `\n# Reranking Disabled\n`;
             envContent += `RERANK_BINDING=null\n`;
        }

        // API Keys (from provider settings — may be overridden by OAuth below)
        const providersNeeded = new Set([llmProvider, embedProvider]);
        envContent += `\n# API Keys\n`;
        providersNeeded.forEach(p => {
            if (p && p.apiKey) {
                const keyName = p.id.toUpperCase(); 
                if (keyName === 'GEMINI') envContent += `GEMINI_API_KEY=${p.apiKey}\n`;
                if (keyName === 'OPENAI') envContent += `OPENAI_API_KEY=${p.apiKey}\n`;
                if (keyName === 'ANTHROPIC') envContent += `ANTHROPIC_API_KEY=${p.apiKey}\n`;
            }
        });
        
        // Entity Types
        if (this.settings.useCustomEntityTypes) {
            const rawTypes = this.settings.lightRagEntityTypes;
            if (rawTypes && rawTypes.trim().length > 0) {
                const typeList = rawTypes.split(',').map(t => t.trim()).filter(t => t.length > 0);
                envContent += `\nENTITY_TYPES='${JSON.stringify(typeList)}'\n`;
            }
        }

        // Custom Overrides
        if (this.settings.lightRagCustomEnv) {
            envContent += `\n\n#####################################\n`;
            envContent += `### USER CUSTOM CONFIGURATION     ###\n`;
            envContent += `### (Overrides defaults above)    ###\n`;
            envContent += `#####################################\n`;
            envContent += this.settings.lightRagCustomEnv;
            envContent += `\n`;
        }

        // OAuth Token (auto-managed by Axiom Cortex)
        // When an OAuth provider is the auth source, we write the token as
        // the standard API key env var that LightRAG already knows how to read.
        // This way no LightRAG code changes are needed — it just sees an API key.
        if (this.settings.lightRagOAuthProvider) {
            const providerId = this.settings.lightRagOAuthProvider;
            const creds = this.settings.oauthCredentials[providerId];
            if (creds) {
                envContent += `\n# OAuth Token (auto-managed by Axiom Cortex)\n`;
                envContent += `OAUTH_PROVIDER=${providerId}\n`;

                // Map OAuth token to the API key env var LightRAG expects.
                // Each OAuth provider maps to a specific LLM API:
                if (providerId === 'anthropic') {
                    // Anthropic OAuth → Anthropic API key
                    envContent += `ANTHROPIC_API_KEY=${creds.access}\n`;
                } else if (providerId === 'openai-codex') {
                    // OpenAI Codex OAuth → OpenAI API key
                    envContent += `OPENAI_API_KEY=${creds.access}\n`;
                } else if (providerId === 'google-antigravity' || providerId === 'google-gemini-cli') {
                    // Google OAuth → Gemini API key (the access token works as bearer token)
                    envContent += `GEMINI_API_KEY=${creds.access}\n`;
                    if (creds.projectId) envContent += `GOOGLE_CLOUD_PROJECT=${creds.projectId}\n`;
                } else if (providerId === 'github-copilot') {
                    // Copilot → OpenAI-compatible API key
                    envContent += `OPENAI_API_KEY=${creds.access}\n`;
                    if (creds.enterpriseUrl) envContent += `COPILOT_ENTERPRISE_URL=${creds.enterpriseUrl}\n`;
                }

                // Also write generic vars for future oauth_binding.py integration
                envContent += `OAUTH_ACCESS_TOKEN=${creds.access}\n`;
                if (creds.projectId) envContent += `OAUTH_PROJECT_ID=${creds.projectId}\n`;
                if (creds.accountId) envContent += `OAUTH_ACCOUNT_ID=${creds.accountId}\n`;
            }
        }

        return envContent;

      } catch (err) {
        console.error("Error generating config:", err);
        return "";
    }
  }

  // Removed async keyword as it performs sync IO and calls void method
  public saveEnvAndRestart(content: string) {
      const workDir = this.settings.lightRagWorkDir;
      if (!workDir) return;
      
      try {
          const envPath = path.join(workDir, '.env');
          fs.writeFileSync(envPath, content);
          this.restartLightRagServer();
      } catch (e) {
          new Notice("Error saving .env file");
          console.error(e);
      }
  }

  public updateEnvFile() {
      const content = this.generateEnvConfig();
      const workDir = this.settings.lightRagWorkDir;
      if (workDir && content) {
          const envPath = path.join(workDir, '.env');
          fs.writeFileSync(envPath, content);
      }
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        
        const onError = () => {
            socket.destroy();
            resolve(false); // Closed
        };

        socket.setTimeout(500); 
        socket.once('error', onError);
        socket.once('timeout', onError);

        socket.connect(port, '127.0.0.1', () => {
            socket.destroy();
            resolve(true); // Open (In Use)
        });
    });
  }

async startLightRagServer() {
    const command = this.settings.lightRagCommand;
    const workDir = this.settings.lightRagWorkDir;

    if (!workDir || !command) {
        new Notice(`Configure ${BACKEND_NAME} paths in settings.`);
        return;
    }

    this.updateEnvFile();

    const isAlive = await this.isPortInUse(9621);
    if (isAlive) {
        this.updateStatusUI('online'); // Si ya está vivo, lo ponemos verde
        return;
    }

    new Notice(`Starting ${BACKEND_NAME}...`);
    this.updateStatusUI('busy'); // Amarillo mientras arranca

    try {
        const envVars = { ...process.env };
        
        this.serverProcess = spawn(command, ['--port', '9621', '--working-dir', workDir,'--workers', '1'], {
            cwd: workDir,
            shell: true,
            env: { ...envVars, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '1' }
        });

        this.serverProcess.stderr?.on('data', (data) => {
            const msg = data.toString();
            const now = Date.now();
            
            if (!this.lastErrorTime || (now - this.lastErrorTime > 5000)) {
                if (msg.includes("503") || msg.includes("overloaded") || msg.includes("UNAVAILABLE")) {
                    new Notice("Provider error: model overloaded (503).\nServer is busy, please wait a moment.", 0);
                    this.lastErrorTime = now;
                }
                else if (msg.includes("Invalid API key") || msg.includes("401")) {
                    if (msg.includes("Rerank")) new Notice(`Rerank error: invalid ${TERM_API} key.`, 0);
                    else new Notice(`${TERM_LLM_EMBED} error: Invalid ${TERM_API} key.`, 0);
                    this.lastErrorTime = now;
                }
                else if (msg.includes("Quota") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
                    if (msg.includes("Rerank")) new Notice("Rerank quota exceeded.", 0);
                    else if (msg.includes("google") || msg.includes("gemini")) new Notice(`Gemini quota exceeded.\nReduce ${VAR_MAX_ASYNC} in settings.`, 0);
                    else new Notice(`${TERM_API} rate limit hit.`, 0);
                    this.lastErrorTime = now;
                }
            }

            if (!msg.includes('INFO:') && !msg.includes('WARNING:')) {
                console.error(`[LightRAG Error]: ${msg}`);
            }
        });
     
        this.serverProcess.on('close', (code) => {
            this.serverProcess = null;
            this.updateStatusUI('offline'); // Si se cierra solo, rojo
        });

        // --- DETECCIÓN REACTIVA (LINTER SAFE) ---
        void (async () => {
            for (let i = 0; i < 15; i++) { // Intentar por 15 segundos
                await new Promise(r => setTimeout(r, 1000));
                const alive = await this.isPortInUse(9621);
                if (alive) {
                    this.updateStatusUI('online'); // ¡Cambio a verde instantáneo!
                    new Notice(`${BACKEND_NAME} activated`);
                    return;
                }
            }
            // Si pasaron 15 segundos y no abrió el puerto:
            this.updateStatusUI('offline');
            new Notice("Server failed to respond in time.");
        })();

    } catch (error) {
        console.error("Error starting server:", error);
        new Notice("Fatal error starting server.");
        this.updateStatusUI('offline');
    }
  }

  async loadSettings() {
    this.settings = parseNeuralComposerSettings(await this.loadData());
    await this.saveData(this.settings);
  }

  async setSettings(newSettings: NeuralComposerSettings) {
    const validationResult = NeuralComposerSettingsSchema.safeParse(newSettings);
    if (!validationResult.success) {
      new Notice('Invalid settings');
      return;
    }
    const oldSettings = this.settings;
    this.settings = newSettings;
    await this.saveData(newSettings);
    this.ragEngine?.setSettings(newSettings);
    this.settingsChangeListeners.forEach((listener) => listener(newSettings));

    // Start/stop proactive discovery on setting change
    if (newSettings.enableProactiveDiscovery && !oldSettings.enableProactiveDiscovery) {
      this.startProactiveDiscovery();
    } else if (!newSettings.enableProactiveDiscovery && oldSettings.enableProactiveDiscovery) {
      this.hideProactiveSuggestionBar();
    }
  }

  addSettingsChangeListener(listener: (newSettings: NeuralComposerSettings) => void) {
    this.settingsChangeListeners.push(listener);
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter((l) => l !== listener);
    };
  }

  openChatView(openNewChat = false) { 
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!view || !editor) {
      void this.activateChatView(undefined, openNewChat);
      return;
    }
    const selectedBlockData = getMentionableBlockData(editor, view);
    void this.activateChatView({ selectedBlock: selectedBlockData ?? undefined }, openNewChat);
  }

async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    this.initialChatProps = chatProps;
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    
    if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
        if (leaf) {
             await leaf.setViewState({
                type: CHAT_VIEW_TYPE,
                active: true,
            });
        }
    }
    
    // Ensure leaf exists before accessing view
    leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];

    if (leaf) {
        // FIX: Add await because revealLeaf returns a Promise
        await this.app.workspace.revealLeaf(leaf);
        
        if (openNewChat && leaf.view instanceof ChatView) {
            leaf.view.openNewChat(chatProps?.selectedBlock);
        }
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view);
    if (!data) return;
    
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({ selectedBlock: data });
      return;
    }
    
    const leaf = leaves[0];
    await this.app.workspace.revealLeaf(leaf);
    
    if (leaf.view instanceof ChatView) {
        const chatView = leaf.view;
        chatView.addSelectionToChat(data);
        chatView.focusMessage();
    }
  }

  // ========================================================================
  // Synthesis Commands (Step 10-13 — stubs for now, full implementation later)
  // ========================================================================

  /**
   * Synthesize: Create cohesive note from graph context.
   * Uses double-lookup: RAG query → LLM synthesis.
   */
  async runSynthesis(selectionText?: string): Promise<void> {
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    const text = selectionText || editor?.getSelection() || editor?.getValue() || '';

    if (!text.trim()) {
      new Notice('No text to synthesize. Select text or write in the active editor.');
      return;
    }

    const notice = new Notice('Synthesizing from graph context...', 0);

    try {
      const ragEngine = await this.getRAGEngine();

      // Lookup 1: Graph query
      const ragResults = await ragEngine.processQuery({ query: text });
      const graphContext = ragResults
        .map((r) => (r as { content?: string }).content || '')
        .filter((c) => c.length > 0)
        .join('\n\n---\n\n');

      if (!graphContext.trim()) {
        notice.setMessage('No graph context found. Ingest some files first.');
        setTimeout(() => notice.hide(), 5000);
        return;
      }

      // Lookup 2: LLM synthesis
      const synthesisPrompt = `You are a knowledge synthesis engine for a personal knowledge graph.

TASK: Synthesize the following into a cohesive, insightful note.

USER FRAGMENTS:
${text}

GRAPH CONTEXT (related entities/connections from the vault):
${graphContext}

INSTRUCTIONS:
1. Identify non-obvious thematic connections between fragments and graph context.
2. Produce a well-structured markdown note.
3. For every concept matching an existing vault note, use [[wikilink]] syntax.
4. Preserve the user's original intent — enhance, don't replace.
5. Use the same language as the user's fragments.`;

      const result = await this.simpleLLMCall(synthesisPrompt);

      // ================================================================
      // Citation Post-Processing: [N] → [[SourcePath| [N] ]]
      //
      // The LightRAG response includes a reference legend mapping [N] to
      // file paths (e.g., "[1] Projects/quantum-notes.md"). The LLM's
      // output may contain numeric citations like [1], [2]. We convert
      // these into Obsidian wikilinks so clicking [1] opens the source.
      //
      // Strategy:
      // 1. Extract reference map from ragResults (lightrag-ref entries)
      // 2. Regex-find all [N] in the LLM output (not inside existing [[]])
      // 3. Replace each [N] with [[sourcePath| [N] ]] if a mapping exists
      // ================================================================
      const referenceMap = new Map<number, string>();
      for (const r of ragResults) {
        const rAny = r as { path?: string; model?: string };
        if (rAny.model === 'lightrag-ref' && rAny.path) {
          // Path format: "[N] filepath" — extract N and filepath
          const refMatch = rAny.path.match(/^\[(\d+)\]\s+(.+)$/);
          if (refMatch) {
            const refNum = parseInt(refMatch[1], 10);
            let filePath = refMatch[2].trim();
            // Strip .md extension for Obsidian wikilink compatibility
            if (filePath.endsWith('.md')) {
              filePath = filePath.slice(0, -3);
            }
            referenceMap.set(refNum, filePath);
          }
        }
      }

      let processedResult = result;
      if (referenceMap.size > 0) {
        // Replace [N] citations that are NOT already inside wikilinks
        // Negative lookbehind for [[ prevents double-wrapping
        processedResult = result.replace(
          /(?<!\[)\[(\d+)\](?!\])/g,
          (_match: string, numStr: string) => {
            const num = parseInt(numStr, 10);
            const sourcePath = referenceMap.get(num);
            if (sourcePath) {
              // Obsidian wikilink with display text: [[path| [N] ]]
              return `[[${sourcePath}| [${num}] ]]`;
            }
            // No mapping found — leave citation as-is
            return _match;
          }
        );
      }

      // Create output note
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outputPath = `Synthesis-${timestamp}.md`;
      await this.app.vault.create(outputPath, processedResult);

      notice.setMessage(`Synthesis complete! Created ${outputPath}`);
      setTimeout(() => notice.hide(), 5000);

      // Open the new note
      const file = this.app.vault.getAbstractFileByPath(outputPath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    } catch (error) {
      console.error('[Axiom Cortex] Synthesis failed:', error);
      notice.setMessage(`Synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(() => notice.hide(), 5000);
    }
  }

  /**
   * Contextual suggestion: Find connecting evidence for selection.
   * Routes to the chat panel with pre-filled graph query.
   */
  async contextualSuggest(editor: Editor, view: MarkdownView): Promise<void> {
    const selection = editor.getSelection();
    if (!selection?.trim()) {
      new Notice('Select some text first.');
      return;
    }

    // Route through existing selection → chat flow with vault search
    await this.addSelectionToChat(editor, view);

    // The chat view will handle the vault search automatically
    new Notice('Finding connecting evidence in your graph...');
  }

  /**
   * Folder synthesis: Pick a folder, ask a question, get a cross-summary note.
   * Uses: folder picker (FuzzySuggestModal pattern), ragEngine.processQuery() with scope, simpleLLMCall().
   */
  async folderSynthesis(): Promise<void> {
    // 1. Prompt user for folder
    const allFolders: TFolder[] = [];
    const collectFolders = (folder: TFolder) => {
      allFolders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) collectFolders(child);
      }
    };
    collectFolders(this.app.vault.getRoot());

    // Use a simple modal for folder selection
    const { Modal, Setting } = await import('obsidian');
    
    const selectedFolder = await new Promise<TFolder | null>((resolve) => {
      class FolderPickerModal extends Modal {
        onOpen() {
          const { contentEl } = this;
          contentEl.createEl('h3', { text: 'Select folder for synthesis' });
          
          const dropdown = contentEl.createEl('select');
          dropdown.setCssProps({ 'width': '100%', 'margin-bottom': '12px' });
          
          for (const folder of allFolders) {
            if (folder.path === '/') continue;
            const opt = dropdown.createEl('option', { text: folder.path, value: folder.path });
          }

          const btnContainer = contentEl.createDiv();
          btnContainer.setCssProps({ 'text-align': 'right', 'margin-top': '12px' });

          const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
          cancelBtn.onclick = () => { this.close(); resolve(null); };

          const okBtn = btnContainer.createEl('button', { text: 'Select', cls: 'mod-cta' });
          okBtn.setCssProps({ 'margin-left': '8px' });
          okBtn.onclick = () => {
            const selected = allFolders.find(f => f.path === dropdown.value);
            this.close();
            resolve(selected || null);
          };
        }
        onClose() { this.contentEl.empty(); }
      }
      new FolderPickerModal(this.app).open();
    });

    if (!selectedFolder) return;

    // 2. Prompt for topic/question
    const topic = await new Promise<string | null>((resolve) => {
      class TopicModal extends Modal {
        onOpen() {
          const { contentEl } = this;
          contentEl.createEl('h3', { text: 'What should be synthesized?' });
          contentEl.createEl('p', { 
            text: `Folder: ${selectedFolder!.path}`,
            cls: 'setting-item-description' 
          });
          
          const input = contentEl.createEl('input', { type: 'text' });
          input.setCssProps({ 'width': '100%' });
          input.placeholder = 'e.g., "Key themes and connections" or a specific question';
          
          const btnContainer = contentEl.createDiv();
          btnContainer.setCssProps({ 'text-align': 'right', 'margin-top': '12px' });

          const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
          cancelBtn.onclick = () => { this.close(); resolve(null); };

          const okBtn = btnContainer.createEl('button', { text: 'Synthesize', cls: 'mod-cta' });
          okBtn.setCssProps({ 'margin-left': '8px' });
          okBtn.onclick = () => { this.close(); resolve(input.value || 'Key themes and connections'); };

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { this.close(); resolve(input.value || 'Key themes and connections'); }
          });
          input.focus();
        }
        onClose() { this.contentEl.empty(); }
      }
      new TopicModal(this.app).open();
    });

    if (!topic) return;

    // 3. Query graph with folder scope
    const notice = new Notice(`Synthesizing folder "${selectedFolder.path}"...`, 0);
    try {
      const ragEngine = await this.getRAGEngine();
      const folderFiles = this.getAllSupportedFiles(selectedFolder);
      const filePaths = folderFiles.map(f => f.path);

      const ragResults = await ragEngine.processQuery({
        query: topic,
        scope: { files: filePaths, folders: [selectedFolder.path] },
      });

      const graphContext = ragResults
        .map((r) => (r as { content?: string }).content || '')
        .filter((c) => c.length > 0)
        .join('\n\n---\n\n');

      // 4. LLM synthesis
      const synthesisPrompt = `You are a knowledge synthesis engine for a personal knowledge graph.

TASK: Create a comprehensive cross-summary of the folder "${selectedFolder.path}" focused on: ${topic}

FOLDER CONTENTS (${filePaths.length} files):
${graphContext || 'No graph context available — the folder may not be ingested yet.'}

INSTRUCTIONS:
1. Identify recurring themes, patterns, and non-obvious connections across the folder's notes.
2. Produce a well-structured markdown note with clear sections.
3. For every concept matching an existing vault note, use [[wikilink]] syntax.
4. Highlight connections between notes that the user might not have noticed.
5. Use the same language as the source material.`;

      const result = await this.simpleLLMCall(synthesisPrompt);

      // 5. Create output note
      const folderName = selectedFolder.name || 'Root';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outputPath = `Folder-Synthesis-${folderName}-${timestamp}.md`;
      await this.app.vault.create(outputPath, result);

      notice.setMessage(`Folder synthesis complete! Created ${outputPath}`);
      setTimeout(() => notice.hide(), 5000);

      const file = this.app.vault.getAbstractFileByPath(outputPath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    } catch (error) {
      console.error('[Axiom Cortex] Folder synthesis failed:', error);
      notice.setMessage(`Folder synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(() => notice.hide(), 5000);
    }
  }

  // ========================================================================
  // Proactive Discovery — debounced editor listener for semantic link suggestions
  // ========================================================================

  private proactiveDiscoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  private proactiveSuggestionBar: HTMLElement | null = null;

  /**
   * Start proactive discovery listener.
   * Called from onLayoutReady when enableProactiveDiscovery is true.
   */
  private startProactiveDiscovery(): void {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) => {
        if (!this.settings.enableProactiveDiscovery) return;

        // Debounce: wait 4 seconds of idle
        if (this.proactiveDiscoveryTimeout) {
          clearTimeout(this.proactiveDiscoveryTimeout);
        }

        this.proactiveDiscoveryTimeout = setTimeout(() => {
          void this.runProactiveDiscovery(editor);
        }, 4000);
      })
    );
  }

  private async runProactiveDiscovery(editor: Editor): Promise<void> {
    try {
      // Get the last paragraph from cursor position
      const cursor = editor.getCursor();
      const lineContent = editor.getLine(cursor.line);
      
      // Collect context: current line + a few lines above
      const startLine = Math.max(0, cursor.line - 3);
      let contextText = '';
      for (let i = startLine; i <= cursor.line; i++) {
        contextText += editor.getLine(i) + '\n';
      }
      contextText = contextText.trim();

      if (contextText.length < 20) return; // Too short for meaningful suggestions

      const ragEngine = await this.getRAGEngine();

      // Lightweight local query for speed
      const results = await ragEngine.processQuery({
        query: contextText,
      });

      // Filter to results above similarity threshold
      const SIMILARITY_THRESHOLD = 0.7;
      const goodResults = results
        .filter((r) => {
          const result = r as { similarity?: number; path?: string };
          return (result.similarity || 0) >= SIMILARITY_THRESHOLD 
            && result.path 
            && result.path !== "Graph's memory"
            && result.path !== "Query error";
        })
        .slice(0, 5);

      if (goodResults.length === 0) {
        this.hideProactiveSuggestionBar();
        return;
      }

      // Extract note names for wikilinks
      const suggestions = goodResults.map((r) => {
        const result = r as { path?: string; metadata?: { fileName?: string } };
        const fileName = result.metadata?.fileName || result.path || '';
        // Strip extension for wikilink
        return fileName.replace(/\.\w+$/, '');
      }).filter(s => s.length > 0);

      if (suggestions.length === 0) {
        this.hideProactiveSuggestionBar();
        return;
      }

      this.showProactiveSuggestionBar(suggestions, editor);
    } catch (error) {
      // Silently fail — proactive discovery should never interrupt the user
      console.debug('[Axiom Cortex] Proactive discovery error:', error);
    }
  }

  private showProactiveSuggestionBar(suggestions: string[], editor: Editor): void {
    this.hideProactiveSuggestionBar();

    const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeLeaf) return;

    const bar = document.createElement('div');
    bar.className = 'nrlcmp-proactive-suggestion-bar';
    bar.setCssProps({
      'position': 'fixed',
      'bottom': '40px',
      'left': '50%',
      'transform': 'translateX(-50%)',
      'background': 'var(--background-secondary)',
      'border': '1px solid var(--background-modifier-border)',
      'border-radius': '8px',
      'padding': '6px 12px',
      'display': 'flex',
      'gap': '8px',
      'align-items': 'center',
      'z-index': '1000',
      'box-shadow': '0 2px 8px rgba(0,0,0,0.15)',
      'font-size': '0.85em',
    });

    const label = bar.createSpan({ text: 'Related: ', cls: 'setting-item-description' });

    for (const suggestion of suggestions) {
      const link = bar.createEl('a', { text: `[[${suggestion}]]`, href: '#' });
      link.setCssProps({
        'cursor': 'pointer',
        'text-decoration': 'none',
        'color': 'var(--text-accent)',
        'padding': '2px 6px',
        'border-radius': '4px',
        'background': 'var(--background-primary)',
      });
      link.onclick = (e) => {
        e.preventDefault();
        // Insert wikilink at cursor
        const cursor = editor.getCursor();
        editor.replaceRange(`[[${suggestion}]]`, cursor);
        this.hideProactiveSuggestionBar();
      };
    }

    // Dismiss button
    const dismissBtn = bar.createEl('span', { text: '✕' });
    dismissBtn.setCssProps({
      'cursor': 'pointer',
      'opacity': '0.5',
      'margin-left': '8px',
      'font-size': '1.1em',
    });
    dismissBtn.onclick = () => this.hideProactiveSuggestionBar();

    document.body.appendChild(bar);
    this.proactiveSuggestionBar = bar;

    // Auto-dismiss after 10 seconds
    setTimeout(() => this.hideProactiveSuggestionBar(), 10000);
  }

  private hideProactiveSuggestionBar(): void {
    if (this.proactiveSuggestionBar) {
      this.proactiveSuggestionBar.remove();
      this.proactiveSuggestionBar = null;
    }
  }

  // --- BYPASS ---
  getDbManager(): Promise<DatabaseManager> { 
      // Changed to return Promise.resolve to satisfy interface without async keyword overhead for mock
      return Promise.resolve({} as DatabaseManager); 
  }

  // Fix: Removed 'async' keyword as the method implementation is synchronous
  // wrapping the result in Promises manually to satisfy the interface.
  getRAGEngine(): Promise<RAGEngine> {
    if (this.ragEngine) return Promise.resolve(this.ragEngine);
    
    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = new Promise<RAGEngine>((resolve, reject) => {
        try {
          this.ragEngine = new RAGEngine(
            this.app, 
            this.settings, 
            // FIX: Use safe double-casting instead of 'any'
            // We cast to unknown first, then to the expected type.
            {} as unknown as VectorManager, 
            () => { 
                this.restartLightRagServer(); 
                return Promise.resolve();
            },
            // OAuth token resolver for Strategy B header injection
            () => this.oauthManager.getActiveLightRagApiKey(),
            // OAuth force-refresh for reactive 401 recovery
            // Mirrors pi-mono AuthStorage.refreshOAuthTokenWithLock()
            () => this.oauthManager.forceRefreshActiveToken(),
          );
          resolve(this.ragEngine);
        } catch (error) {
          this.ragEngineInitPromise = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    return this.ragEngineInitPromise;
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) return this.mcpManager;
    try {
      this.mcpManager = new McpManager({
        settings: this.settings,
        registerSettingsListener: (l) => this.addSettingsChangeListener(l),
      });
      await this.mcpManager.initialize();
      return this.mcpManager;
    } catch (error) {
      this.mcpManager = null;
      throw error;
    }
  }

  // --- AUTOMATED ONTOLOGIST ---
  public async generateEntityTypes(): Promise<string | null> {
    const sourcePath = this.settings.lightRagOntologyFolder;
    
    if (!sourcePath) {
        new Notice("Please define an 'ontology source folder' first.");
        return null;
    }

    const folder = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!folder || !(folder instanceof TFolder)) {
        new Notice(`Folder not found: "${sourcePath}"`);
        return null;
    }

    new Notice(`Analyzing notes in "${sourcePath}"...`);

    try {
        const allFiles = this.getAllSupportedFiles(folder);
        if (allFiles.length === 0) throw new Error("Folder is empty.");
        
        const sampleSize = Math.min(allFiles.length, 5);
        const sampleFiles = allFiles.sort(() => 0.5 - Math.random()).slice(0, sampleSize);
        
        let sampleText = "";
        for (const file of sampleFiles) {
            const content = await this.app.vault.read(file);
            sampleText += `--- NOTE: ${file.basename} ---\n${content.substring(0, 1000)}\n...\n\n`;
        }

        const targetLang = this.settings.lightRagSummaryLanguage || 'English';

        const prompt = `
        ACT AS: Senior Data Ontologist & Knowledge Graph Architect.
        TASK: Analyze the provided user's "${sourcePath}" folder to extract the fundamental ontology.
        GOAL: Define a concise list of high-level "Entity Types" that cover the majority of the concepts in the text without being overly granular.
        
        GUIDELINES FOR ENTITY TYPES:
        - **Abstraction:** Prefer broad categories (e.g., use "Organization" instead of "Company", "Startup", "NGO").
        - **Relevance:** Include types for abstract concepts (e.g., "Concept", "Methodology", "Goal") as LightRAG relies on conceptual connections.
        - **Coverage:** The list should allow classifying at least 90% of the key nouns in the text.
        
        RULES:
        1. Output ONLY a comma-separated list of types. NO preamble, NO markdown, NO explanations.
        2. Types must be singular and PascalCase (e.g., ResearchPaper, SoftwareTool).
        3. Limit the list to the top 8-15 most relevant types.
        4. CRITICAL: The output types MUST be in ${targetLang}.

        SAMPLE CONTENT:
        ${sampleText}

        YOUR OUTPUT:
        `;

        const generatedTypes = await this.simpleLLMCall(prompt);
        
        if (generatedTypes) {
            const cleanTypes = generatedTypes.replace(/Here are...|Output:|\[|\]/gi, '').trim();
            
            await this.setSettings({
                ...this.settings,
                lightRagEntityTypes: cleanTypes
            });
            
            new Notice("Ontology generated!");
            this.updateEnvFile();
            
            return cleanTypes; 
        }

    } catch (e) {
        console.error(e);
        new Notice("Error generating ontology.");
    }
    return null;
  }

  // Simple Helper for LLM Call
  async simpleLLMCall(prompt: string): Promise<string> {
      const chatModelId = this.settings.chatModelId;
      const modelObj = this.settings.chatModels.find(m => m.id === chatModelId);
      const provider = this.settings.providers.find(p => p.id === modelObj?.providerId);
      
      if (!provider || !modelObj) throw new Error("Model not configured");

      // Gemini Logic
      if (provider.id === 'gemini') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelObj.model}:generateContent?key=${provider.apiKey}`;
          
          const response = await requestUrl({
              url: url,
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });
          
          const data = response.json;
          return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } 
      
      // Generic Fallback (OpenAI/Ollama/Compatible)
      const baseUrl = provider.baseUrl || (provider.id === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434/v1');
      
      const response = await requestUrl({
          url: `${baseUrl}/chat/completions`,
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${provider.apiKey || 'ollama'}`
          },
          body: JSON.stringify({
              model: modelObj.model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1
          })
      });
      
      const data = response.json;
      return data.choices?.[0]?.message?.content || "";
  }

  // --- STATUS BAR LOGIC ---
  private startStatusHeartbeat() {
      // Revisar cada 30 segundos
      this.heartbeatInterval = window.setInterval(() => {
          void this.checkAndUpdateStatus();
      }, 30000);
      // Primera revisión inmediata
      void this.checkAndUpdateStatus();
  }

private async checkAndUpdateStatus() {
      // Si el proceso no existe y no está el auto-start, está offline
      if (!this.settings.enableAutoStartServer && !this.serverProcess) {
          this.updateStatusUI('offline');
          return;
      }

      try {
          const response = await requestUrl({
              url: "http://localhost:9621/health",
              method: "GET",
              throw: false
          });
          
          if (response.status === 200) {
              // Fix: Explicit type annotation for response data
              const data: { pipeline_busy?: boolean } = response.json;
              const isBusy = data?.pipeline_busy ?? false;
              this.updateStatusUI(isBusy ? 'busy' : 'online');
          } else {
              this.updateStatusUI('offline');
          }
      } catch {
          this.updateStatusUI('offline');
      }
  }

  private updateStatusUI(status: 'online' | 'offline' | 'busy') {
      if (!this.statusDotEl) return;
      this.statusDotEl.removeClass('is-online', 'is-offline', 'is-busy');
      
      if (status === 'online') {
          this.statusDotEl.addClass('is-online');
          setTooltip(this.statusBarEl, 'LightRAG: Online');
      } else if (status === 'busy') {
          this.statusDotEl.addClass('is-busy');
          setTooltip(this.statusBarEl, 'LightRAG: Processing...');
      } else {
          this.statusDotEl.addClass('is-offline');
          setTooltip(this.statusBarEl, 'LightRAG: Offline (Click to restart)');
      }
  }

  private async handleStatusBarClick() {
      const isAlive = await this.isPortInUse(9621);
      if (!isAlive) {
          new Notice(`Starting ${BACKEND_NAME} from status bar...`);
          void this.startLightRagServer();
      } else {
          new Notice("System is already online.");
      }
  }

}