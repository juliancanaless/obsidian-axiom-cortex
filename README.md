# Axiom Cortex

**OAuth-powered, graph-based knowledge synthesis for Obsidian — built on Neural Composer and pi-mono.**

> **Fork lineage:** [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) (Heesu Suh) → [Neural Composer](https://github.com/oscampo/obsidian-neural-composer) (Oscar Campo) → **Axiom Cortex** (Julian Canales)

---

## What Is This?

Axiom Cortex extends Neural Composer with a full **OAuth bridge** and **knowledge synthesis engine**, letting you authenticate via Google Antigravity, GitHub Copilot, Anthropic, OpenAI Codex, or Gemini CLI — and use those credentials to power LightRAG graph queries and multi-step note synthesis, all without manual API key management.

---

## Credit & Lineage

### Smart Composer — Heesu Suh ([glowingjade](https://github.com/glowingjade/obsidian-smart-composer))

The original Obsidian plugin that started it all. Provided the foundational architecture:

- Chat view sidebar with model selection
- Provider/model settings system with schema migrations
- MCP (Model Context Protocol) integration
- Embedding model client and vector database layer
- The core plugin lifecycle (`onload`, `onunload`, settings management)

### Neural Composer — Oscar Campo ([oscampo](https://github.com/oscampo/obsidian-neural-composer))

Oscar forked Smart Composer and added the **LightRAG graph engine integration**, turning a standard vector-search chat plugin into a full knowledge graph system:

- **LightRAG server management** — auto-start/stop of the Python backend process
- **Graph RAG queries** — hybrid search combining vector similarity with graph traversal via `processQuery()`
- **Document ingestion** — text and binary file upload to the LightRAG server (`/documents/texts`, `/documents/upload`)
- **Folder-level ingestion** — right-click context menu to ingest entire folders
- **Custom ontology** — user-defined entity types for graph construction
- **Reranking support** — Jina AI and local reranker integration
- **`.env` generation** — automatic environment file creation for the LightRAG server
- **Server restart logic** — restart-on-failure with auto-retry
- **Citation transparency** — `[1]`, `[2]` references from LightRAG responses shown in chat

### Axiom Cortex — Julian Canales ([juliancanaless](https://github.com/juliancanaless))

My additions build the **OAuth bridge** and **synthesis layer** on top of Neural Composer:

#### OAuth System (ported from [pi-mono](https://github.com/mariozechner/pi-mono))
- **5 OAuth providers** — Anthropic, GitHub Copilot, Google Antigravity, Gemini CLI, OpenAI Codex
- **OAuthManager** — credential storage, auto-refresh (15-min background timer), force-refresh on 401
- **OAuthLoginModal** — vanilla Obsidian Modal for provider selection and login flow
- **OAuthSection** — React settings panel showing login status per provider
- **PKCE authentication** — full PKCE flow for all providers, ported from pi-mono
- **Token delivery (Strategy A)** — `.env` rewrite + server restart when tokens change
- **Token delivery (Strategy B)** — per-request `X-OAuth-Provider`/`X-OAuth-Token` header injection with Python middleware that overrides `os.environ` per-request scope

#### Reactive Error Handling
- **401/403 detection** in `performQuery()` with typed error propagation
- **Silent token refresh** — on auth failure, force-refreshes via `provider.refreshToken()` and retries with fresh headers
- **Graceful degradation** — if refresh fails, clears credentials and prompts re-login

#### Knowledge Synthesis Commands
- **`synthesize-note`** — double-lookup (graph query → LLM synthesis) creating a new note with wikilinks
- **`contextual-suggestion`** — routes selection to chat with graph-powered context
- **`folder-synthesis`** — pick a folder + topic, get a cross-note summary
- **`proactive-links`** — 4-second debounced editor listener with similarity-threshold floating suggestion bar

#### Citation Post-Processing
- Regex-based `[N]` → `[[SourcePath| [N] ]]` conversion using the LightRAG reference legend
- Clickable wikilinks in synthesized notes that open the original source files

#### Python Backend (Reference Implementations)
- **`oauth_middleware.py`** — Starlette middleware for Strategy B (per-request `os.environ` override)
- **`oauth_binding.py`** — Antigravity request wrapping with exact pi-mono header constants (`User-Agent`, `X-Goog-Api-Client`, Cloud Code Assist envelope)

#### Schema & Settings
- Schema version 12→13 migration with `oauthCredentials`, `lightRagOAuthProvider`, `enableProactiveDiscovery`
- "Auth source for LightRAG" dropdown in Neural settings section
- Proactive discovery toggle

---

## Prerequisites

- **Obsidian** 1.0.0+
- **Node.js** 18+ and **npm**
- **Python** 3.10+ (for the LightRAG backend)

---

## Installation

### 1. Clone and Build

```bash
git clone https://github.com/juliancanaless/axiom-cortex.git
cd axiom-cortex
npm install
npm run build
```

### 2. Install the LightRAG Backend

```bash
pip install "lightrag-hku[api]"
```

> Use a virtual environment if you prefer: `python -m venv .venv && source .venv/bin/activate`

### 3. Install into Obsidian

Copy the built plugin into your vault's plugin folder:

```bash
# Replace <YOUR_VAULT> with your actual vault path
mkdir -p <YOUR_VAULT>/.obsidian/plugins/axiom-cortex
cp main.js manifest.json styles.css <YOUR_VAULT>/.obsidian/plugins/axiom-cortex/
```

Then in Obsidian:
1. Go to **Settings → Community Plugins**
2. Disable **Restricted Mode** if needed
3. Click **Reload** — Axiom Cortex should appear in the list
4. Enable it

### 4. Configure

Go to **Settings → Axiom Cortex**:

1. **Providers** — Enter API keys for any providers you want to use directly (Gemini, OpenAI, Ollama)
2. **OAuth** — Click "Login" to authenticate via any OAuth provider (Antigravity, Copilot, Anthropic, etc.)
3. **Neural Backend** — Set the path to your `lightrag-server` executable, choose a data folder, and enable Auto-start
4. **Auth Source** — Select which OAuth provider's token should be used for LightRAG (in the Neural section)

### 5. Ingest & Query

- Right-click any folder → **"Add to Graph"** to ingest notes
- Open the chat sidebar to query your knowledge graph
- Use the command palette for synthesis commands:
  - `Axiom Cortex: Synthesize Note` — create a note from graph context
  - `Axiom Cortex: Folder Synthesis` — cross-summarize a folder
  - `Axiom Cortex: Proactive Links` — toggle the floating suggestion bar

---

## Development

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Type checking
npx tsc --noEmit

# Run tests
npx jest --no-cache

# Production build
npm run build
```

### Project Structure

```
src/
├── auth/
│   ├── OAuthManager.ts          # Credential manager, refresh logic
│   └── oauth/                   # Provider implementations (from pi-mono)
│       ├── anthropic.ts
│       ├── github-copilot.ts
│       ├── google-antigravity.ts
│       ├── google-gemini-cli.ts
│       ├── openai-codex.ts
│       ├── pkce.ts
│       ├── types.ts
│       └── index.ts
├── components/
│   ├── modals/
│   │   └── OAuthLoginModal.ts   # Login flow UI
│   └── settings/
│       └── sections/
│           ├── OAuthSection.tsx  # OAuth status panel
│           └── NeuralSection.tsx # Auth source dropdown
├── core/
│   └── rag/
│       └── ragEngine.ts         # LightRAG client, 401 retry, header injection
├── settings/
│   └── schema/
│       ├── setting.types.ts     # Schema with OAuth fields
│       └── migrations/
│           ├── 12_to_13.ts      # OAuth migration
│           └── 12_to_13.test.ts
└── main.ts                      # Plugin entry, commands, synthesis logic

backend/
├── oauth_middleware.py           # Strategy B: per-request env override
└── oauth_binding.py              # Antigravity request wrapping
```

---

## License

MIT — see [LICENSE](LICENSE).

Original copyright holders:
- © 2024 Heesu Suh (Smart Composer)
- © 2025–2026 Oscar Campo (Neural Composer)
- © 2026 Julian Canales (Axiom Cortex)

---

## Acknowledgements

- **[Smart Composer](https://github.com/glowingjade/obsidian-smart-composer)** by Heesu Suh — the original plugin architecture
- **[Neural Composer](https://github.com/oscampo/obsidian-neural-composer)** by Oscar Campo — LightRAG integration and graph RAG
- **[pi-mono](https://github.com/mariozechner/pi-mono)** by Mario Zechner — OAuth provider implementations (Antigravity, Copilot, Anthropic, Gemini CLI, OpenAI Codex)
- **[LightRAG](https://github.com/HKUDS/LightRAG)** by HKUDS — the graph retrieval engine
- **[Obsidian](https://obsidian.md)** — the knowledge management platform
