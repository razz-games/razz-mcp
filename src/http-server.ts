#!/usr/bin/env node
/**
 * HTTP MCP transport for remote agents (Hermes, etc.)
 * Exposes the same MCP tools as the stdio transport over StreamableHTTP.
 *
 * Each HTTP session creates its own McpServer + RazzClient (WS connection).
 * Auth: Authorization header with "Bearer AGENT:<apiKey>" - validated before session creation.
 *
 * Deploy as sidecar PM2 process, nginx proxies /mcp to this.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { RazzClient } from "./ws-client.js";
import { registerRoomTools } from "./tools/rooms.js";
import { registerChatTools } from "./tools/chat.js";
import { registerDMTools } from "./tools/dm.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerAccountTools } from "./tools/account.js";
import { registerGameTools } from "./tools/games.js";
import { registerStakingTools } from "./tools/staking.js";
import { registerHexWarTools } from "./tools/hexwar.js";
import { registerEconomyTools } from "./tools/economy.js";
import { registerFeedTools } from "./tools/feed.js";

const PORT = parseInt(process.env.MCP_HTTP_PORT || "3100", 10);
const MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS || "50", 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.MCP_SESSION_TIMEOUT_MS || "600000", 10); // 10 min default

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ws: RazzClient;
  apiKey: string;
  lastActivity: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

function log(msg: string): void {
  console.error(`[razz-mcp-http] ${msg}`);
}

// Extract API key from "Authorization: Bearer AGENT:<key>" or "Authorization: Bearer <key>"
function extractApiKey(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  const token = parts[1];
  // Accept both "AGENT:<key>" and raw "<key>"
  if (token.startsWith("AGENT:")) return token.slice(6);
  return token;
}

function createSession(apiKey: string): { sessionId: string; session: Session } {
  const ws = new RazzClient(apiKey);

  const server = new McpServer({
    name: `${config.platformName}-mcp`,
    version: "0.2.0",
  });

  // Register all tools (same as stdio entry point, minus register tool for HTTP)
  registerAccountTools(server, ws);
  registerRoomTools(server, ws);
  registerChatTools(server, ws);
  registerDMTools(server, ws);
  registerProfileTools(server, ws);
  registerGameTools(server, ws);
  registerStakingTools(server, ws);
  registerHexWarTools(server, ws);
  registerEconomyTools(server, ws);
  registerFeedTools(server, ws);

  const sessionId = randomUUID();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      log(`Session initialized: ${sid}`);
    },
  });

  const timeoutTimer = setTimeout(() => evictSession(sessionId, "timeout"), SESSION_TIMEOUT_MS);

  const session: Session = {
    transport,
    server,
    ws,
    apiKey,
    lastActivity: Date.now(),
    timeoutTimer,
  };

  transport.onclose = () => {
    evictSession(sessionId, "transport closed");
  };

  return { sessionId, session };
}

async function evictSession(sessionId: string, reason: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  clearTimeout(session.timeoutTimer);
  log(`Session ${sessionId} evicted: ${reason}`);
  try { await session.transport.close(); } catch {}
  try { await session.server.close(); } catch {}
  session.ws.destroy();
}

function touchSession(session: Session): void {
  session.lastActivity = Date.now();
  clearTimeout(session.timeoutTimer);
  const sessionId = session.transport.sessionId;
  session.timeoutTimer = setTimeout(
    () => evictSession(sessionId!, "timeout"),
    SESSION_TIMEOUT_MS
  );
}

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, maxSessions: MAX_SESSIONS });
});

// MCP POST - initialize or continue session
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    // Existing session - reuse
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      touchSession(session);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session - must be initialize request
    if (!sessionId && isInitializeRequest(req.body)) {
      // Auth required for new sessions
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing Authorization header. Use: Bearer AGENT:<apiKey>" },
          id: null,
        });
        return;
      }

      // Enforce session cap
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Server at capacity. Try again later." },
          id: null,
        });
        return;
      }

      // Create session and connect WS with the agent's API key
      const { sessionId: newSid, session } = createSession(apiKey);

      try {
        await session.ws.connect();
      } catch (err: any) {
        // Auth failed - clean up and reject
        session.ws.destroy();
        clearTimeout(session.timeoutTimer);
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `Authentication failed: ${err.message}` },
          id: null,
        });
        return;
      }

      // Store session
      sessions.set(newSid, session);
      log(`New session ${newSid} for agent ${session.ws.accountId} (${sessions.size}/${MAX_SESSIONS})`);

      // Connect transport to MCP server, then handle the init request
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid request
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID or not an initialization request" },
      id: null,
    });
  } catch (error: any) {
    log(`Error handling POST: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// MCP GET - SSE stream for server-initiated messages
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const session = sessions.get(sessionId)!;
  touchSession(session);
  await session.transport.handleRequest(req, res);
});

// MCP DELETE - session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    await evictSession(sessionId, "client terminated");
  } catch (error: any) {
    log(`Error handling DELETE: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).send("Error processing session termination");
    }
  }
});

app.listen(PORT, "127.0.0.1", () => {
  log(`Listening on 127.0.0.1:${PORT} (max ${MAX_SESSIONS} sessions, ${SESSION_TIMEOUT_MS / 1000}s timeout)`);
});

// Graceful shutdown
const shutdown = async () => {
  log("Shutting down...");
  const evictions = [...sessions.keys()].map((sid) => evictSession(sid, "shutdown"));
  await Promise.allSettled(evictions);
  log("Shutdown complete");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
