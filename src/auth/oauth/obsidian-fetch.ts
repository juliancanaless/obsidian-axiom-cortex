/**
 * Obsidian-compatible HTTP client for OAuth providers.
 *
 * Obsidian's `requestUrl` bypasses CORS entirely (it runs via Electron's
 * main process, not the renderer's fetch). This is critical because many
 * OAuth endpoints (especially Google's cloudcode-pa.googleapis.com) don't
 * return CORS headers, causing renderer-side `fetch()` to fail.
 *
 * This module exports `obsidianFetch` — a drop-in replacement for `fetch()`
 * that uses Obsidian's `requestUrl` under the hood.
 */

import { requestUrl } from 'obsidian';

interface ObsidianFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * fetch()-compatible wrapper around Obsidian's requestUrl.
 * Handles all the quirks:
 * - requestUrl throws on 4xx by default → we use throw: false
 * - Body can be string, URLSearchParams, or undefined
 * - Returns a fetch-like Response object
 */
export async function obsidianFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    signal?: AbortSignal;
  },
): Promise<ObsidianFetchResponse> {
  // Convert URLSearchParams body to string with correct content type
  let bodyStr: string | undefined;
  const headers: Record<string, string> = { ...(init?.headers || {}) };

  if (init?.body instanceof URLSearchParams) {
    bodyStr = init.body.toString();
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (typeof init?.body === 'string') {
    bodyStr = init.body;
  }

  const response = await requestUrl({
    url,
    method: init?.method || 'GET',
    headers,
    body: bodyStr,
    throw: false,
  });

  const responseText = response.text;
  const responseStatus = response.status;

  return {
    ok: responseStatus >= 200 && responseStatus < 300,
    status: responseStatus,
    statusText: `${responseStatus}`,
    text: async () => responseText,
    json: async () => response.json,
  };
}
