// Pre-existing: @modelcontextprotocol/sdk ships without type declarations.
// These ambient declarations match the actual SDK API surface used by
// mcpManager.ts, mcp.types.ts, and responseGenerator.ts so `npm run build` succeeds.

declare module '@modelcontextprotocol/sdk/client/index.js' {
  import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types';
  export class Client {
    constructor(info: Record<string, unknown>, options?: Record<string, unknown>);
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
    listTools(): Promise<{ tools: Tool[] }>;
    callTool(
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<CallToolResult>;
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export class StdioClientTransport {
    constructor(options: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    });
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/types' {
  export interface Tool {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };
  }
  export interface CallToolResult {
    content: Array<{ type: string; text: string; [key: string]: unknown }>;
    isError?: boolean;
  }
}
