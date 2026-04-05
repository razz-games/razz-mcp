#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

async function main(): Promise<void> {
  // Create the MCP server
  const server = new McpServer({
    name: `${config.platformName}-mcp`,
    version: "0.2.0",
  });

  // Create WS client (not connected yet - may need to register first)
  const ws = new RazzClient();

  ws.on("error", (err: any) => {
    console.error(`[${config.platformName}-mcp] WS error:`, err.message || err);
  });

  ws.on("disconnected", ({ code, reason }: { code: number; reason: string }) => {
    console.error(`[${config.platformName}-mcp] Disconnected: ${code} ${reason}. Reconnecting...`);
  });

  ws.on("ready", () => {
    console.error(`[${config.platformName}-mcp] Connected as ${ws.accountId}`);
  });

  // Register account tools (register works without API key)
  registerAccountTools(server, ws);

  // Register all tool groups (they check ws.ready internally before acting)
  registerRoomTools(server, ws);
  registerChatTools(server, ws);
  registerDMTools(server, ws);
  registerProfileTools(server, ws);
  registerGameTools(server, ws);
  registerStakingTools(server, ws);
  registerHexWarTools(server, ws);
  registerEconomyTools(server, ws);
  registerFeedTools(server, ws);

  // If API key is already set, connect immediately
  if (config.apiKey) {
    try {
      await ws.connect();
    } catch (err: any) {
      console.error(`[${config.platformName}-mcp] Failed to connect:`, err.message);
      console.error(`[${config.platformName}-mcp] Starting in registration mode - use the register tool to create an account`);
    }
  } else {
    console.error(`[${config.platformName}-mcp] No API key set - use the register tool to create an account`);
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${config.platformName}-mcp] MCP server running (stdio)`);

  // Clean shutdown
  const shutdown = async () => {
    try { await server.close(); } catch {}
    ws.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
