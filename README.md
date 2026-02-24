# Axiom Cortex

**OAuth-powered Graph RAG for Obsidian — knowledge synthesis with clickable citations and proactive link discovery.**

> Fork lineage: [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) → [Neural Composer](https://github.com/oscampo/obsidian-neural-composer) → **Axiom Cortex**

---

## What Does It Do?

Axiom Cortex connects your Obsidian vault to a **knowledge graph** powered by [LightRAG](https://github.com/HKUDS/LightRAG). Instead of keyword search, it follows relationships between your ideas — then synthesizes new notes from those connections.

It also provides an **OAuth bridge** to authenticate with Google Antigravity, GitHub Copilot, Anthropic, Gemini CLI, and OpenAI Codex, so you never have to copy-paste API keys manually.

### Key Capabilities

| Feature | What It Does |
|---|---|
| **Graph RAG Chat** | Ask complex questions across your vault — the graph follows entity relationships, not just keyword matches |
| **Insight Synthesizer** | Select text → pulls graph context → LLM creates a new note with `[[wikilinks]]` and clickable `[1]` citations |
| **Folder Synthesis** | Pick a folder + topic → get a cross-note summary with source links |
| **Proactive Discovery** | As you type, a floating bar suggests related notes from your graph in real time |
| **OAuth Login** | One-command authentication for 5 providers — tokens auto-refresh in the background |
| **Clickable Citations** | Numeric references `[1]`, `[2]` from the graph are converted to `[[wikilinks]]` that open the source file |

---

## Installation via BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewer's Auto-update Tool) is the recommended installation method. It handles updates automatically.

### Step 1 — Install BRAT

1. Open **Settings → Community Plugins → Browse**
2. Search for **BRAT** and install it
3. Enable BRAT in your plugin list

### Step 2 — Add Axiom Cortex

1. Open the Command Palette (`Cmd+P` / `Ctrl+P`)
2. Run **BRAT: Plugins: Add a beta plugin for testing**
3. Paste the repository URL:
   ```
   juliancanaless/obsidian-axiom-cortex
   ```
4. Click **Add Plugin**
5. Go to **Settings → Community Plugins** and enable **Axiom Cortex**

BRAT will automatically pull `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release.

### Manual Installation (Alternative)

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/juliancanaless/obsidian-axiom-cortex/releases/latest), then:

```bash
mkdir -p <YOUR_VAULT>/.obsidian/plugins/axiom-cortex
cp main.js manifest.json styles.css <YOUR_VAULT>/.obsidian/plugins/axiom-cortex/
```

Restart Obsidian → enable **Axiom Cortex** in Community Plugins.

---

## Sidecar Setup (LightRAG Backend)

Axiom Cortex uses a local Python server as its graph engine. This runs on `localhost:9621` and is managed automatically by the plugin.

### Requirements

- **Python 3.10+** — verify with `python3 --version`
- **pip** — verify with `pip3 --version`

### Install LightRAG

```bash
pip install "lightrag-hku[api]"
```

> A virtual environment is recommended:
> ```bash
> python3 -m venv ~/.axiom-venv
> source ~/.axiom-venv/bin/activate
> pip install "lightrag-hku[api]"
> ```
> If using a venv, set the **Server Executable Path** in settings to point to the `lightrag-server` binary inside your venv's `bin/` folder.

### Install the Antigravity Middleware (Optional)

If you plan to use Google Antigravity or Gemini CLI OAuth for your graph queries, install the middleware dependencies:

```bash
pip install httpx starlette
```

Then copy the middleware files from the `backend/` folder of this repository into your LightRAG server directory:

```bash
cp backend/oauth_middleware.py backend/oauth_binding.py <YOUR_LIGHTRAG_SERVER_DIR>/
```

### Configure the Backend

Open **Settings → Axiom Cortex → Neural Backend**:

1. **Server Executable Path** — the full path to `lightrag-server` (e.g., `~/.axiom-venv/bin/lightrag-server`)
2. **Data Folder** — where the graph database is stored (e.g., `~/axiom-data`)
3. **Auto-start** — enable this so the server starts/stops with Obsidian
4. Click **Restart Server** to verify it connects

---

## OAuth Authentication

Axiom Cortex supports 5 OAuth providers for API access. No API keys to copy — just login.

### How to Login

1. Open the Command Palette (`Cmd+P`)
2. Run **Axiom Cortex: OAuth Login**
3. Select a provider:

| Provider | Access | Auth Flow |
|---|---|---|
| **Antigravity** | Gemini 3, Claude, GPT-OSS via Google Cloud | Browser redirect → `localhost:51121` |
| **Gemini CLI** | Gemini models via Cloud Code Assist | Browser redirect → `localhost:8085` |
| **GitHub Copilot** | GPT-4o, Claude via Copilot | Device code (enter code at github.com/login/device) |
| **Anthropic** | Claude Pro/Max | PKCE → manual code paste |
| **OpenAI Codex** | GPT-4, o1, o3 | Browser redirect → `localhost:1455` |

4. Complete the browser-based login
5. The token is stored locally and auto-refreshes in the background

### Set the Auth Source for Graph Queries

Go to **Settings → Axiom Cortex → Neural** and set **Auth source for LightRAG** to your preferred OAuth provider. This tells the plugin which token to use when the graph engine makes LLM calls.

### How Token Delivery Works

The plugin delivers OAuth tokens to LightRAG via two mechanisms:

- **Strategy A (Restart):** When a token changes, the plugin rewrites the `.env` file and restarts the LightRAG server. This is the fallback for unpatched LightRAG installs.
- **Strategy B (Per-request):** Every request to LightRAG includes `X-OAuth-Provider` and `X-OAuth-Token` headers. If the middleware is installed, the server uses these directly — no restart needed.

---

## How to Use

### Insight Synthesizer (Double-Lookup)

The core synthesis workflow:

1. Select text in any note (or have text in the active editor)
2. Open Command Palette → **Axiom Cortex: Synthesize Note**
3. The plugin runs a two-step process:
   - **Lookup 1:** Queries the knowledge graph for related entities and connections
   - **Lookup 2:** Sends your text + graph context to the LLM for synthesis
4. A new `Synthesis-<timestamp>.md` note is created and opened

The output includes `[[wikilinks]]` to existing vault notes and clickable citations.

### Clickable Citations

When the graph engine returns numbered references (`[1]`, `[2]`, etc.) pointing to source files, the synthesizer converts them into Obsidian wikilinks:

```
[1] → [[Projects/quantum-notes| [1] ]]
[2] → [[Research/attention-paper| [2] ]]
```

Click any `[1]` in the synthesized note to jump directly to the source file.

### Folder Synthesis

1. Command Palette → **Axiom Cortex: Folder Synthesis**
2. Select a folder from your vault
3. Enter a topic or question
4. The plugin queries all notes in that folder via the graph, then synthesizes a cross-note summary

### Proactive Link Discovery

1. Command Palette → **Axiom Cortex: Proactive Links** (or enable in Settings → Neural → Proactive Discovery)
2. As you type, the plugin queries the graph with your recent text
3. A floating suggestion bar appears with related notes above a 0.7 similarity threshold
4. Click a suggestion to open the linked note
5. The bar auto-dismisses after 10 seconds of inactivity

---

## Troubleshooting

### Port Conflicts

The plugin uses several localhost ports:

| Port | Purpose | Fix if Blocked |
|---|---|---|
| `9621` | LightRAG server | Change in Settings → Neural Backend → Server Port |
| `51121` | Antigravity OAuth callback | Kill the process using the port: `lsof -ti:51121 \| xargs kill` |
| `8085` | Gemini CLI OAuth callback | `lsof -ti:8085 \| xargs kill` |
| `1455` | OpenAI Codex OAuth callback | `lsof -ti:1455 \| xargs kill` |

If a port is permanently unavailable, OAuth callbacks for that provider won't work. The port values are hardcoded in the provider implementations (matching Google's/OpenAI's registered redirect URIs and cannot be changed).

### Token Expiry and Refresh

- **Automatic:** A background timer runs every 15 minutes and refreshes any token within 10 minutes of expiry. You shouldn't need to think about this.
- **Reactive:** If a graph query gets a `401 Unauthorized`, the engine silently force-refreshes the token and retries once — you won't see an error unless the refresh itself fails.
- **Manual re-login required when:**
  - The refresh token itself has been revoked (e.g., you changed your Google password)
  - The provider's OAuth app has been deauthorized from your account
  - You see the Notice: *"OAuth token expired for X. Please login again."*
  - Run **Axiom Cortex: OAuth Login** from the Command Palette to re-authenticate

### Antigravity Version Spoofing

The Antigravity gateway validates the `User-Agent` header. If Google pushes a mandatory update that rejects the current version string, you can override it without waiting for a plugin update.

**In the TypeScript OAuth provider** (`src/auth/oauth/google-antigravity.ts`), the version is used during the login/project-discovery flow. These headers use `google-api-nodejs-client/9.15.1` which is stable.

**In the Python middleware** (`backend/oauth_binding.py`), the inference headers use `antigravity/{version} darwin/arm64`. To update:

1. Set the environment variable before starting Obsidian:
   ```bash
   export PI_AI_ANTIGRAVITY_VERSION="1.16.0"
   ```
2. Or edit the default in `backend/oauth_binding.py`:
   ```python
   DEFAULT_ANTIGRAVITY_VERSION = "1.16.0"
   ```

The current default (`1.15.8`) matches the value in [pi-mono](https://github.com/mariozechner/pi-mono) as of February 2026.

### Build Failures

If `npm run build` fails with type errors about MCP modules, these are pre-existing and do not affect the build. The esbuild bundler ignores type errors — only `tsc --noEmit` reports them. Run this to verify only real errors:

```bash
npx tsc --noEmit 2>&1 | grep 'error TS' | grep -v mcp
```

If that returns nothing, you're clean.

---

## Development

```bash
git clone https://github.com/juliancanaless/obsidian-axiom-cortex.git
cd obsidian-axiom-cortex
npm install
npm run dev        # Watch mode
npm run build      # Production build
npx tsc --noEmit   # Type check
npx jest           # Run tests
```

### Creating a Release

Push a version tag to trigger the GitHub Actions release workflow:

```bash
git tag 2.0.1
git push origin 2.0.1
```

The workflow will:
1. Bump the version in `manifest.json`, `package.json`, and `versions.json`
2. Build the plugin
3. Create a GitHub Release with `main.js`, `manifest.json`, and `styles.css` as assets
4. BRAT will pick up the new release automatically

---

## Project Structure

```
src/
├── auth/
│   ├── OAuthManager.ts            # Credential storage, refresh, force-refresh
│   └── oauth/                     # Provider implementations (from pi-mono)
│       ├── anthropic.ts           # PKCE + manual code paste
│       ├── github-copilot.ts      # Device code flow
│       ├── google-antigravity.ts  # Browser redirect, project discovery
│       ├── google-gemini-cli.ts   # Browser redirect, Cloud Code Assist
│       ├── openai-codex.ts        # Browser redirect
│       ├── pkce.ts                # PKCE generation (Electron-compatible)
│       ├── types.ts               # Credential and provider interfaces
│       └── index.ts               # Provider registry
├── components/
│   ├── modals/
│   │   └── OAuthLoginModal.ts     # Provider selection and login UI
│   └── settings/sections/
│       ├── OAuthSection.tsx       # Login status panel
│       └── NeuralSection.tsx      # Auth source dropdown, proactive toggle
├── core/rag/
│   └── ragEngine.ts               # LightRAG client, 401 retry, header injection
├── settings/schema/
│   ├── setting.types.ts           # Schema with OAuth + proactive fields
│   └── migrations/
│       ├── 12_to_13.ts            # OAuth migration
│       └── 12_to_13.test.ts       # Migration tests
└── main.ts                        # Plugin entry, commands, synthesis logic

backend/
├── oauth_middleware.py             # Strategy B: per-request env override
└── oauth_binding.py                # Antigravity request wrapping
```

---

## Credit & Lineage

This project builds on the work of three open-source projects:

- **[Smart Composer](https://github.com/glowingjade/obsidian-smart-composer)** by Heesu Suh — original plugin architecture, chat view, provider system
- **[Neural Composer](https://github.com/oscampo/obsidian-neural-composer)** by Oscar Campo — LightRAG integration, graph RAG, document ingestion, server management
- **[pi-mono](https://github.com/mariozechner/pi-mono)** by Mario Zechner — OAuth provider implementations (Antigravity, Copilot, Anthropic, Gemini CLI, OpenAI Codex)
- **[LightRAG](https://github.com/HKUDS/LightRAG)** by HKUDS — the graph retrieval engine

## License

MIT — see [LICENSE](LICENSE).

```
© 2024 Heesu Suh (Smart Composer)
© 2025–2026 Oscar Campo (Neural Composer)
© 2026 Julian Canales (Axiom Cortex)
```
