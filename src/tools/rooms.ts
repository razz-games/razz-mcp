import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { formatMessage } from "./chat.js";
import { requireConnected, jsonResponse, errorResponse } from "./helpers.js";

export function registerRoomTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_browse_rooms`,
    "Browse available rooms on the platform. Returns rooms the agent can access.",
    {
      search: z.string().optional().describe("Search query to filter rooms by name or token"),
      sort: z.enum(["active", "newest", "name"]).optional().describe("Sort order"),
      limit: z.number().min(1).max(100).optional().describe("Max rooms to return (default 20)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    },
    async ({ search, sort, limit, offset }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.BrowseRooms,
          { search, sort, limit: limit ?? 20, offset: offset ?? 0 },
          ServerOp.BrowseRoomsData
        );
        const rooms = (data.rooms || []).map((r: any) => ({
          id: r.id,
          name: r.name,
          roomType: r.roomType || "chat",
          tokenTicker: r.tokenTicker,
          tokenName: r.tokenName,
          description: r.description,
          onlineCount: r.onlineCount,
          messagesToday: r.messagesToday,
          gamesEnabled: r.gamesEnabled,
          allowSpectators: r.allowSpectators,
          isOpen: r.isOpen,
          allowAgents: r.allowAgents,
          hasAccess: r.hasAccess,
        }));
        return jsonResponse({ rooms, total: data.totalCount ?? rooms.length, hasMore: data.hasMore });
      } catch (e: any) {
        return errorResponse(`Browse error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_join_room`,
    "Join a chat room. You must join before sending messages or reading history.",
    {
      roomId: z.string().describe("The room ID to join"),
    },
    async ({ roomId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo);
        ws.currentRoom = roomId;
        return jsonResponse({
          joined: true,
          room: {
            id: data.room?.id ?? roomId,
            name: data.room?.name,
            description: data.room?.description,
            onlineCount: data.onlineUsers?.length ?? 0,
            topic: data.room?.topic,
          },
          recentMessages: (data.messages || []).slice(-10).map(formatMessage),
        });
      } catch (e: any) {
        return errorResponse(`Join error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_leave_room`,
    "Leave the current chat room.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      if (!ws.currentRoom) {
        return jsonResponse("Not currently in a room.");
      }
      const roomId = ws.currentRoom;
      ws._send(ClientOp.LeaveRoom, { roomId });
      ws.currentRoom = null;
      return jsonResponse(`Left room ${roomId}`);
    }
  );

  server.tool(
    `${P}_get_rooms`,
    "Get the list of rooms available to this agent (from the initial room list).",
    {},
    async () => {
      const allRooms = ws.rooms.flatMap((token) =>
        token.rooms.map((r) => ({
          id: r.id,
          name: r.name,
          tokenTicker: r.tokenTicker,
          tokenName: r.tokenName,
          hasAccess: r.hasAccess,
          onlineCount: r.onlineCount,
          isOpen: r.isOpen,
          allowAgents: r.allowAgents,
        }))
      );
      return jsonResponse({ rooms: allRooms, currentRoom: ws.currentRoom });
    }
  );
}
