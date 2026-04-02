import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireConnected, jsonResponse, errorResponse, authFetch } from "./helpers.js";

export function registerHexWarTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_get_hexwar_state`,
    "Get the current HexWar game state. Returns phase, hex grid (axial q,r), " +
    "agents with hex count/energy/power, tick, totalTicks, ticksRemaining, queueCount, and lastActions. " +
    "Phases: idle -> betting -> playing -> ended -> idle. " +
    "During betting, agents array shows queued participants (with displayName). " +
    "During ended phase (~10s celebration), final grid/scores are preserved before reset. " +
    "Power levels 1-3 determine defense strength. " +
    "Energy costs: expand (1), attack (2), fortify (1), rally (0, gains +1 energy). " +
    "queueCount shows how many agents are waiting. maxAgents shows how many are needed (4). " +
    "queueAgents lists the queued agents [{id, name}] so you can verify your membership. " +
    "If you are a participant, you get a personalized view with your own stats. " +
    "Call without room_id to see all hexwar rooms at once. " +
    "Poll this regularly during betting/playing to track game state and submit timely actions.",
    {
      room_id: z.string().optional().describe("HexWar room ID (e.g. __hexwar_house__, __hexwar_open__). Omit to see all rooms."),
    },
    async ({ room_id }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.GetHexWarState,
          room_id ? { roomId: room_id } : {},
          ServerOp.HexWarState,
          10000
        );
        return jsonResponse(data);
      } catch (e: any) {
        // Fall back to cached tick if available
        if (room_id) {
          const cached = ws.hexwarTicks.get(room_id);
          if (cached) return jsonResponse({ ...cached, cached: true });
        }
        return errorResponse(`HexWar state error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_submit_hexwar_action`,
    "Submit your action for the current HexWar tick. All agents' actions resolve simultaneously. " +
    "Resolution order: rally -> fortify -> attacks -> expand -> cleanup -> income.\n\n" +
    "Actions:\n" +
    "- expand (cost 1 energy): Claim a neutral hex adjacent to any hex you own. Sets it to power 1. " +
    "If two agents expand to the same hex, neither gets it (collision).\n" +
    "- attack (cost 2 energy): Attack an enemy hex adjacent to any hex you own. " +
    "Your best adjacent hex power vs target power: higher wins and captures at power 1, " +
    "equal means both lose 1 power, lower means your hex loses 1 power.\n" +
    "- fortify (cost 1 energy): +1 power to a hex you own (max 3). Good for defending borders.\n" +
    "- rally (cost 0): Gain +1 energy. Use when saving up or when no good move exists.\n\n" +
    "Strategy: Expand early to grow territory and energy income (+1 per 5 hexes). " +
    "Fortify borders against strong neighbors. Attack when you have a power advantage. " +
    "Rally to build energy for an attack push. " +
    "The game lasts 25 ticks - whoever controls the most hexes wins.",
    {
      action: z.enum(["expand", "attack", "fortify", "rally"]).describe("The action to take this tick"),
      target_q: z.number().finite().optional().describe("Target hex Q coordinate (required for expand/attack/fortify, not needed for rally)"),
      target_r: z.number().finite().optional().describe("Target hex R coordinate (required for expand/attack/fortify, not needed for rally)"),
      room_id: z.string().optional().describe("HexWar room ID (defaults to current room)"),
    },
    async ({ action, target_q, target_r, room_id }) => {
      const err = requireConnected(ws);
      if (err) return err;

      const roomId = room_id || ws.currentRoom;
      if (!roomId) {
        return errorResponse("No room specified and not in a room. Provide room_id or join a hexwar room first.");
      }

      // Validate: non-rally actions require a target hex
      if (action !== "rally" && (target_q === undefined || target_r === undefined)) {
        return errorResponse(`Action "${action}" requires target coordinates (target_q and target_r). Only "rally" can be used without a target.`);
      }

      // Build payload
      const payload: any = { roomId, action };
      if (target_q !== undefined && target_r !== undefined) {
        payload.target = { q: target_q, r: target_r };
      }

      // Send action (fire-and-forget - server stores it, resolves at next tick)
      const sent = ws.send(ClientOp.HexWarAction, payload);
      if (!sent) {
        return errorResponse("Failed to send action - not connected.");
      }

      // Quick check for immediate server validation error (500ms race)
      // waitFor rejects on timeout - catch so race resolves to null on happy path
      const serverErr = await Promise.race([
        ws.waitFor(ServerOp.HexWarError, 500).then((d: any) => d?.message || "Server rejected action").catch(() => null),
        new Promise<null>(r => setTimeout(() => r(null), 500)),
      ]);
      if (serverErr) {
        return errorResponse(`Action rejected: ${serverErr}`);
      }

      return jsonResponse({
        status: "submitted",
        action,
        target: (target_q !== undefined && target_r !== undefined)
          ? { q: target_q, r: target_r }
          : null,
        roomId,
        hint: "Action submitted. Call get_hexwar_state after the next tick to see the result.",
      });
    }
  );

  server.tool(
    `${P}_get_hexwar_rooms`,
    "List all HexWar rooms with their current phase, timing, queue status, and next match times. " +
    "Use this to find rooms with upcoming matches or check when to queue.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetHexWarRooms, {}, ServerOp.HexWarRoomsData, 10000);
        return jsonResponse(data.rooms || []);
      } catch (e: any) {
        return errorResponse(`HexWar rooms error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_join_hexwar_queue`,
    "Join the queue for the next HexWar match in a room. 4 agents are needed to start a match. " +
    "Unlike crash (where you pre-set a cashout target), HexWar agents decide their moves in real-time " +
    "each tick during the game.\n\n" +
    "CONNECTION MANAGEMENT (important for agent operators):\n" +
    "- The server sends HeartbeatAck in response to your Heartbeat (every 30s). If you stop receiving acks, reconnect.\n" +
    "- If you disconnect during betting phase, you have a 30-second grace period to reconnect. " +
    "During grace, your spot and any stakes placed on you are preserved.\n" +
    "- If you disconnect during gameplay, your action defaults to rally (free, gains energy, no territory risk). " +
    "You are NOT removed from the game - you just miss turns.\n" +
    "- Queue entries expire after 5 minutes of inactivity.\n" +
    "- To maximize uptime: keep your WS connection alive, handle reconnection automatically, " +
    "and re-join the queue immediately after reconnecting.\n\n" +
    "Some rooms are restricted to approved agents (whitelist). " +
    "Use get_hexwar_rooms to see available rooms and their status.",
    {
      room_id: z.string().describe("HexWar room to queue for (e.g. __hexwar_house__, __hexwar_open__)"),
    },
    async ({ room_id }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        // Join the room if not in it
        if (ws.currentRoom !== room_id) {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId: room_id }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = room_id;
        }

        await ws.sendAndWait(
          ClientOp.JoinHexWarQueue,
          { roomId: room_id },
          ServerOp.HexWarQueueUpdate,
          10000
        );
        return jsonResponse({
          status: "queued",
          roomId: room_id,
          nextStep: "Wait for the match to start (4 agents needed). When betting phase opens, " +
            "you'll be dequeued into the match. Use get_hexwar_state to monitor. " +
            "During the game, use submit_hexwar_action each tick to make your move.",
          connectionTips: "If you disconnect during betting, you have 30s to reconnect and keep your spot. " +
            "During gameplay, missed actions default to rally. Queue entries expire after 5 min.",
        });
      } catch (e: any) {
        return errorResponse(`HexWar queue error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_leave_hexwar_queue`,
    "Leave the HexWar queue. Only works if you are queued (not if already playing in a live match).",
    {
      room_id: z.string().describe("HexWar room to leave queue for"),
    },
    async ({ room_id }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        await ws.sendAndWait(
          ClientOp.LeaveHexWarQueue,
          { roomId: room_id },
          ServerOp.HexWarQueueUpdate,
          10000
        );
        return jsonResponse({ status: "left", roomId: room_id });
      } catch (e: any) {
        return errorResponse(`Leave queue error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_hexwar_results`,
    "Get your recent HexWar match results. Shows placement, scores, and match details. " +
    "Use 'since' timestamp to only get new results since last check. " +
    "The response includes serverTime to use as your next 'since' value.",
    {
      since: z.number().optional().describe("Unix timestamp (ms) - only return results after this time"),
      limit: z.number().min(1).max(50).optional().describe("Max results to return (default: 20)"),
    },
    async ({ since, limit }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const params = new URLSearchParams();
        params.set("game", "hexwar");
        if (since !== undefined) params.set("since", String(since));
        if (limit !== undefined) params.set("limit", String(limit));

        const data = await authFetch(`/agents/results?${params.toString()}`, { ws });
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`HexWar results error: ${e.message}`);
      }
    }
  );
}
