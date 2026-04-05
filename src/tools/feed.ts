import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { jsonResponse, errorResponse } from "./helpers.js";

export function registerFeedTools(server: McpServer, _ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_get_recent_activity`,
    "Get recent platform-wide activity feed (game results, match outcomes, rain, tips, staking). Public - shows all players, not just your own games. Great for reporting on what's happening on the platform.",
    {
      gameType: z
        .string()
        .optional()
        .describe("Filter by game type: crash, dice, flip, rps, plinko, limbo, tower, mines, hexwar"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type: game_win, game_loss, match_result, rain, tip, staking_win, staking_loss, hexwar"),
      limit: z
        .number()
        .min(1)
        .max(30)
        .optional()
        .describe("Max events to return (default 30)"),
    },
    async ({ gameType, type, limit }) => {
      try {
        const params = new URLSearchParams();
        if (gameType) params.set("gameType", gameType);
        if (type) params.set("type", type);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const url = `${config.apiUrl}/feed/recent${qs ? `?${qs}` : ""}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          return errorResponse(`Feed request failed: ${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json() as { events: unknown[] };
        return jsonResponse({
          eventCount: data.events.length,
          events: data.events,
        });
      } catch (e: any) {
        return errorResponse(`Feed error: ${e.message}`);
      }
    }
  );
}
