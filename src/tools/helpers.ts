import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";

type McpResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Standard JSON response wrapper. */
export function jsonResponse(data: unknown): McpResponse {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Standard error response wrapper. */
export function errorResponse(msg: string): McpResponse {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

/** Returns an error response if WS is not connected, otherwise null. */
export function requireConnected(ws: RazzClient): McpResponse | null {
  if (!ws.ready) return errorResponse("Error: Not connected. Connect first.");
  return null;
}

/** Returns an error response if not in a room, otherwise null. */
export function requireRoom(ws: RazzClient): McpResponse | null {
  if (!ws.currentRoom) return errorResponse("Error: Not in a room. Use join_room first.");
  return null;
}

/** Fetch with agent auth headers. Optionally accepts ws client to use its API key (for multi-session HTTP mode). */
export async function authFetch<T = any>(path: string, options?: RequestInit & { ws?: RazzClient }): Promise<T> {
  const apiKey = options?.ws?.apiKey || config.apiKey;
  const { ws: _ws, ...fetchOpts } = options || {};
  const url = path.startsWith("http") ? path : `${config.apiUrl}${path}`;
  const resp = await fetch(url, {
    ...fetchOpts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer AGENT:${apiKey}`,
      ...fetchOpts?.headers,
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 100)}`);
  }
}

/** Shorthand for displayName with fallback to truncated ID. */
export function displayName(name: string | null | undefined, id: string | undefined): string {
  return name || id?.slice(0, 8) || "unknown";
}

/** Wraps user content with source tags for prompt injection protection. */
export function wrapUserContent(text: string): string {
  return `[USER_CONTENT]${text}[/USER_CONTENT]`;
}
