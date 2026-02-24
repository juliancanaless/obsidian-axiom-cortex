import { App, TFile, Notice, requestUrl } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { VectorManager } from '../../database/modules/vector/VectorManager'
import { SelectEmbedding } from '../../database/schema'
import { NeuralComposerSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'

import { getEmbeddingModelClient } from './embedding'

// OAuth token resolver type — injected from main.ts
export type OAuthTokenResolver = () => Promise<{ providerId: string; apiKey: string } | undefined>;

/**
 * Callback to force-refresh the active OAuth token.
 * Mirrors pi-mono's AuthStorage.refreshOAuthTokenWithLock() pattern:
 *   1. Check if token is expired
 *   2. Call provider.refreshToken(creds) to get fresh credentials
 *   3. Persist new credentials (triggers .env rewrite for Strategy A)
 *   4. Return the fresh API key
 *
 * Returns undefined if no OAuth provider is active or refresh fails.
 * Reference: pi-mono/packages/coding-agent/src/core/auth-storage.ts lines 265-321
 */
export type OAuthForceRefresh = () => Promise<{ providerId: string; apiKey: string } | undefined>;

// Helper type matching the method signature to avoid 'any' casting
type RagQueryResult = (Omit<SelectEmbedding, 'embedding'> & { similarity: number })[];

// Interface for internal results
interface RagResult extends Partial<SelectEmbedding> {
    id: number;
    model?: string;
    path: string;
    content: string;
    similarity: number;
    mtime?: number;
    metadata?: {
        startLine: number;
        endLine: number;
        fileName?: string;
        content?: string;
    };
}

// FIX: New interface to type the API response and avoid 'any'
interface LightRagAPIResponse {
    response?: string;
    references?: {
        file_path?: string;
        content?: string;
    }[];
    [key: string]: unknown; // Allow other props safely
}

export class RAGEngine {
  private app: App
  private settings: NeuralComposerSettings
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private restartServerCallback: () => Promise<void>;
  private oauthTokenResolver: OAuthTokenResolver | null = null;
  private oauthForceRefresh: OAuthForceRefresh | null = null;

  constructor(
    app: App,
    settings: NeuralComposerSettings,
    vectorManager: VectorManager,
    restartServerCallback?: () => Promise<void>,
    oauthTokenResolver?: OAuthTokenResolver,
    oauthForceRefresh?: OAuthForceRefresh,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = vectorManager
    this.restartServerCallback = restartServerCallback || (() => Promise.resolve()); 
    this.oauthTokenResolver = oauthTokenResolver || null;
    this.oauthForceRefresh = oauthForceRefresh || null;
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  cleanup() {
    this.embeddingModel = null
    this.vectorManager = null
  }

  setSettings(settings: NeuralComposerSettings) {
    this.settings = settings
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  /**
   * Build request headers, injecting OAuth token headers (Strategy B).
   *
   * The LightRAG server middleware reads X-OAuth-Provider and X-OAuth-Token
   * from incoming request headers and overrides the process-level API keys
   * for that request's scope. This eliminates server restarts on token refresh.
   *
   * The oauthTokenResolver calls OAuthManager.getActiveLightRagApiKey() which
   * auto-refreshes expired tokens via provider.refreshToken() before returning —
   * matching the pi-mono AuthStorage.getApiKey() contract.
   *
   * Reference: pi-mono/packages/ai/src/utils/oauth/index.ts getOAuthApiKey()
   */
  private async getRequestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.oauthTokenResolver) {
      try {
        const token = await this.oauthTokenResolver();
        if (token) {
          headers["X-OAuth-Provider"] = token.providerId;
          headers["X-OAuth-Token"] = token.apiKey;
        }
      } catch (error) {
        console.error("[RAGEngine] Failed to resolve OAuth token:", error);
        // Fall through — backend will use env-based credentials
      }
    }

    return headers;
  }

  // Correct: Returns Promise<void> directly without async/await overhead
  updateVaultIndex(
    options: { reindexAll: boolean } = { reindexAll: false },
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<void> {
    if (!this.embeddingModel) return Promise.reject(new Error('Embedding model is not set'));
    return Promise.resolve();
  }

  // --- 1. TEXT INGESTION ---
  async insertDocument(content: string, description?: string): Promise<boolean> {
    const safeName = description && description.trim() ? description : `Note_${Date.now()}.md`;
    try {
      const headers = await this.getRequestHeaders();
      const response = await requestUrl({
          url: "http://localhost:9621/documents/texts",
          method: "POST",
          headers,
          body: JSON.stringify({ "texts": [content], "file_sources": [safeName] }),
          throw: false 
      });

      if (response.status >= 400) {
        throw new Error(`Error ${response.status}: ${response.text}`);
      }
      return true;
    } catch (error) {
      console.error("Error in input of text:", error);
      new Notice(`Error saving to the graph: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // --- 2. BINARY INGESTION (Manual Multipart) ---
  async uploadDocument(file: TFile): Promise<boolean> {
    try {
      const fileData = await this.app.vault.readBinary(file);
      
      const boundary = "----ObsidianBoundary" + Date.now().toString(16);
      
      const prePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const postPart = `\r\n--${boundary}--\r\n`;

      const preBuffer = new TextEncoder().encode(prePart);
      const postBuffer = new TextEncoder().encode(postPart);
      const bodyBuffer = new Uint8Array(preBuffer.length + fileData.byteLength + postBuffer.length);

      bodyBuffer.set(preBuffer, 0);
      bodyBuffer.set(new Uint8Array(fileData), preBuffer.length);
      bodyBuffer.set(postBuffer, preBuffer.length + fileData.byteLength);

      // Get OAuth headers but override Content-Type for multipart
      const oauthHeaders = await this.getRequestHeaders();
      const headers = {
        ...oauthHeaders,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      };

      const response = await requestUrl({
        url: "http://localhost:9621/documents/upload",
        method: "POST",
        headers,
        body: bodyBuffer.buffer, 
        throw: false
      });

      if (response.status >= 400) {
        throw new Error(`Error ${response.status}: ${response.text}`);
      }

      return true;
    } catch (error) {
      console.error("Error uploading file:", error);
      new Notice(`Error uploading ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // --- 3. MASTER QUERY ---
  async processQuery({
    query,
    scope,
    onQueryProgressChange,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<RagQueryResult> {
    
    // 1. LOCAL STRATEGY
    if (scope && scope.files && scope.files.length > 0) {
        const localResults: RagResult[] = [];
        for (const filePath of scope.files) {
             const file = this.app.vault.getAbstractFileByPath(filePath);
             if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                localResults.push({
                    id: -1, model: 'local-file', path: filePath, content: content, similarity: 1.0, mtime: file.stat.mtime,
                    metadata: { startLine: 0, endLine: 0, fileName: file.name, content: content }
                });
             }
        }
        onQueryProgressChange?.({ type: 'querying-done', queryResult: [] });
        // Safe casting to expected return type
        return localResults as unknown as RagQueryResult;
    }

    // 2. GLOBAL STRATEGY
    onQueryProgressChange?.({ type: 'querying' })

    // FIX: Typed return promise to avoid implicit 'any' from response.json
    const performQuery = async (overrideHeaders?: Record<string, string>): Promise<LightRagAPIResponse> => {
        const headers = overrideHeaders || await this.getRequestHeaders();
        const response = await requestUrl({
            url: "http://localhost:9621/query",
            method: "POST",
            headers,
            body: JSON.stringify({ 
                query: query, mode: "hybrid", stream: false, only_need_context: false
            }),
            throw: false
        });
        
        if (response.status >= 400) {
            const errorText = response.text;
            if (response.status === 401 || response.status === 403) {
                // Throw a typed error so the retry block can detect auth failures
                const authError = new Error(`Status ${response.status}: ${errorText}`);
                (authError as Error & { statusCode: number }).statusCode = response.status;
                throw authError;
            }
            if (errorText.toLowerCase().includes("quota") || errorText.toLowerCase().includes("credit") || errorText.toLowerCase().includes("429")) {
                new Notice("Rerank error: quota exceeded. Please check your API key.", 0);
            }
            else if (errorText.toLowerCase().includes("rerank")) {
                new Notice(`Reranking error: ${errorText}`, 5000);
            }
            throw new Error(`Status ${response.status}: ${errorText}`);
        }
        // FIX: Cast to interface instead of returning 'any'
        return response.json as LightRagAPIResponse;
    };

    try {
      // FIX: Explicit type for data variable
      let data: LightRagAPIResponse;
      try {
          data = await performQuery();
      } catch (firstError) {
          const statusCode = (firstError as Error & { statusCode?: number }).statusCode;

          // ============================================================
          // Reactive 401/403 Refresh & Retry
          //
          // Mirrors pi-mono's AuthStorage.getApiKey() pattern:
          //   1. Detect auth failure (401/403)
          //   2. Force-refresh the OAuth token via provider.refreshToken()
          //   3. Retry the request with the fresh token
          //
          // This is the Strategy B equivalent of pi-mono's
          // refreshOAuthTokenWithLock() → retry flow in auth-storage.ts.
          //
          // Reference: pi-mono/packages/coding-agent/src/core/auth-storage.ts
          //            lines 291-321 (locked refresh + fallback to re-read)
          // ============================================================
          if ((statusCode === 401 || statusCode === 403) && this.oauthForceRefresh) {
              console.warn("[RAGEngine] Auth failure detected, attempting silent token refresh...");
              try {
                  const freshToken = await this.oauthForceRefresh();
                  if (freshToken) {
                      // Build new headers with the refreshed token
                      const refreshedHeaders: Record<string, string> = {
                          "Content-Type": "application/json",
                          "X-OAuth-Provider": freshToken.providerId,
                          "X-OAuth-Token": freshToken.apiKey,
                      };
                      console.log("[RAGEngine] Token refreshed successfully, retrying request...");
                      data = await performQuery(refreshedHeaders);
                  } else {
                      // Refresh returned nothing — token is gone, surface to user
                      new Notice("OAuth session expired. Please re-login via the OAuth command.", 8000);
                      throw firstError;
                  }
              } catch (refreshError) {
                  // Refresh itself failed — credentials are invalid
                  console.error("[RAGEngine] Silent token refresh failed:", refreshError);
                  new Notice("OAuth token refresh failed. Please re-login via Settings → OAuth.", 8000);
                  throw firstError;
              }
          } else if (this.settings.enableAutoStartServer) {
              // Non-auth error: try server restart (original fallback)
              console.warn("First attempt failed (non-auth)...", firstError);
              onQueryProgressChange?.({ type: 'querying' }); 
              new Notice("Waking up the system...");
              await this.restartServerCallback();
              await new Promise(resolve => setTimeout(resolve, 4000));
              data = await performQuery();
          } else {
              throw firstError;
          }
      }

      const results: RagResult[] = [];
      // Data is now typed, so we can access properties safely
      const graphAnswer = data.response || "";
      
      let masterContent = graphAnswer;
      if (data.references && Array.isArray(data.references)) {
          masterContent += "\n\n--- ORIGINAL REFERENCES (DATA LAYER) ---\n";
          // CORRECCIÓN: Quitamos ': any' y dejamos que TS infiera el tipo desde la interfaz LightRagAPIResponse
          data.references.forEach((ref, index) => {
              const docName = ref.file_path || `Source ${index + 1}`;
              masterContent += `[${index + 1}] ${docName}\n`;
          });
      }

      if (masterContent) {
          results.push({
              id: -1, model: 'lightrag-master', path: "Graph's memory",
              content: masterContent, similarity: 1.0, mtime: Date.now(),
              metadata: { startLine: 0, endLine: 0, fileName: "Graph answer", content: masterContent }
          });
      }

      if (data.references && Array.isArray(data.references)) {
          for (let i = 0; i < data.references.length; i++) {
              const ref = data.references[i];
              const filePath = ref.file_path || `Source #${i+1}`;
              const docName = `[${i + 1}] ${filePath}`; 
              results.push({
                  id: -(i + 2), model: 'lightrag-ref', path: `${docName}`,
                  content: `[Full content of ${docName}]:\n${ref.content || "..."}`, 
                  similarity: 0.5, mtime: Date.now(),
                  metadata: { startLine: 0, endLine: 0, fileName: filePath }
              });
          }
      }

      onQueryProgressChange?.({ type: 'querying-done', queryResult: [] })
      return results as unknown as RagQueryResult;

    } catch (error: unknown) {
      console.error("Final error:", error);
      const message = error instanceof Error ? error.message : String(error);
      const errorDoc: RagResult = {
          id: -2, path: "Query error",
          content: `No response could be obtained from graph.\n\nPossible cause: ${message}\n\nIf you use reranking, check your credits.`,
          similarity: 1.0, metadata: { startLine: 0, endLine: 0 }
      };
      return [errorDoc] as unknown as RagQueryResult;
    }
  }

  private getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel) return Promise.reject(new Error('Embedding model not set'));
    return this.embeddingModel.getEmbedding(query)
  }
}