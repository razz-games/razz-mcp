import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireConnected, jsonResponse, errorResponse } from "./helpers.js";

export function registerStakingTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_get_match_info`,
    "Get current match info for a spectator/crash room - participants, staking pool, status, crash state, and result. " +
    "Returns match data when a round is active, plus live crash state (phase, multiplier, players, next round time).",
    {
      roomId: z.string().optional().describe("Room ID to get match info for (defaults to current room)"),
    },
    async ({ roomId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const targetRoom = roomId || ws.currentRoom;
      if (!targetRoom) {
        return errorResponse("Error: No room specified and not in a room. Provide roomId or join a room first.");
      }
      try {
        const data = await ws.sendAndWait(ClientOp.GetMatchInfo, { roomId: targetRoom }, ServerOp.MatchInfo, 10000);

        const response: any = {};

        if (data.match) {
          response.match = data.match;
          if (data.yourStakes?.length) response.yourStakes = data.yourStakes;
        }

        // Always include crash state when available
        if (data.crashTick) {
          const tick = data.crashTick;
          response.crashState = {
            phase: tick.phase,
            multiplier: tick.multiplier,
            players: tick.players,
            ...(tick.bettingEndsAt ? { bettingEndsAt: tick.bettingEndsAt } : {}),
            ...(tick.nextRoundAt ? {
              nextRoundAt: tick.nextRoundAt,
              nextRoundInSeconds: Math.max(0, Math.round((tick.nextRoundAt - Date.now()) / 1000)),
            } : {}),
          };
        }

        // Helpful status when no match exists
        if (!data.match) {
          if (data.crashTick) {
            response.status = data.crashTick.phase === "idle" ? "between_rounds" : data.crashTick.phase;
            response.hint = "No stakeable match right now. A match is created when the next betting phase opens.";
          } else {
            response.status = "no_active_match";
            response.hint = "No match or crash round active. Use get_crash_rooms to find rooms with active rounds.";
          }
        }

        return jsonResponse(response);
      } catch (e: any) {
        return errorResponse(`Match info error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_place_stake`,
    "Place a stake on an agent in a match. Bet on which agent will win. Returns updated pool info with implied odds.",
    {
      matchId: z.string().describe("The match ID to stake on"),
      agentId: z.string().describe("The agent's account ID to back (e.g. __agent_claude__)"),
      amount: z.number().min(0.001).max(0.5).describe("Amount to stake in SOL (min 0.001, max 0.5)"),
      currency: z.string().optional().describe("Currency to stake (default: SOL)"),
    },
    async ({ matchId, agentId, amount, currency }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.PlaceStake,
          { matchId, agentId, amount, currency: currency || "SOL" },
          ServerOp.StakingUpdate,
          10000
        );
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Place stake error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_cancel_stake`,
    "Cancel an active stake on an agent in a match. Only works while staking is still open.",
    {
      matchId: z.string().describe("The match ID to cancel stake on"),
      agentId: z.string().describe("The agent's account ID you staked on"),
    },
    async ({ matchId, agentId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        ws.send(ClientOp.CancelStake, { matchId, agentId });
        const data = await ws.sendAndWait(ClientOp.GetMatchInfo, { roomId: matchId }, ServerOp.MatchInfo, 10000);
        return jsonResponse({ status: "cancelled", matchId, agentId, pool: data?.match?.pool });
      } catch (e: any) {
        return errorResponse(`Cancel stake error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_agent_stats`,
    "Get an agent's profile and performance stats - win rate, profit, play style, recent form, and per-game breakdown.",
    {
      accountId: z.string().describe("Agent's account ID (e.g. __agent_claude__)"),
    },
    async ({ accountId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetAgentStats, { accountId }, ServerOp.AgentStatsData, 10000);
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Agent stats error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_match_history`,
    "Get recent match history for an agent. Shows outcomes, profits, and participants for past matches.",
    {
      accountId: z.string().optional().describe("Agent's account ID (defaults to your own)"),
      limit: z.number().min(1).max(50).optional().describe("Number of matches to return (default: 10, max: 50)"),
    },
    async ({ accountId, limit }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetMatchHistory, { accountId, limit }, ServerOp.MatchHistoryData, 10000);
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Match history error: ${e.message}`);
      }
    }
  );
}
