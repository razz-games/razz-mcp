import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireRoom, requireConnected, jsonResponse, errorResponse, displayName, wrapUserContent } from "./helpers.js";

/** Format a raw message for agent consumption.
 * Content is wrapped with source tags to help agents distinguish
 * user-generated content from system instructions. */
function formatMessage(m: any) {
  const base: any = {
    id: m.id,
    author: displayName(m.authorName, m.authorId),
    authorId: m.authorId,
    createdAt: m.createdAt,
    isAgent: m.isAgent,
    _source: "user_message",
  };

  // Parse __game__ system messages into friendly format
  if (m.authorId === "__game__" || m.authorName === "__game__") {
    try {
      const g = typeof m.content === "string" ? JSON.parse(m.content) : m.content;
      base.type = "game_result";
      base.author = "[game]";
      base.game = {
        gameType: g.gameType,
        playerName: g.playerName || g.players?.[0]?.name,
        ...(g.gameType === "dice" ? { roll: g.roll } : {}),
        ...(g.gameType === "flip" ? { outcome: g.outcome } : {}),
        ...(g.gameType === "crash" ? { crashPoint: g.crashPoint, players: g.players?.length } : {}),
      };
      delete base.isAgent;
      return base;
    } catch { /* fall through to normal message */ }
  }

  base.type = m.replyToId ? "reply" : "message";
  base.content = wrapUserContent(m.content);
  if (m.replyToId) base.replyToId = m.replyToId;
  if (m.replyCount) base.replyCount = m.replyCount;
  const reactions = m.reactions?.filter((r: any) => r.count > 0);
  if (reactions?.length) base.reactions = reactions;
  return base;
}

export { formatMessage };

export function registerChatTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_send_message`,
    "Send a message to the room you've joined. You must join a room first.",
    {
      content: z.string().max(2000).describe("Message content"),
      replyToId: z.string().optional().describe("Message ID to reply to (creates a thread)"),
    },
    async ({ content, replyToId }) => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.SendMessage,
          { roomId: ws.currentRoom, content, replyToId },
          ServerOp.NewMessage
        );
        return jsonResponse({
          sent: true,
          messageId: data.id,
          content: data.content,
          createdAt: data.createdAt,
        });
      } catch (e: any) {
        return errorResponse(`Send error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_read_messages`,
    "Read recent messages from the room you've joined. Returns up to 50 messages. " +
    "Use 'since' to get messages after a timestamp (forward), or 'before' for older messages (backward).",
    {
      before: z.number().optional().describe("Load messages before this timestamp (backward pagination)"),
      since: z.number().optional().describe("Load messages after this timestamp (forward pagination - get new messages since last check)"),
    },
    async ({ before, since }) => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.LoadHistory,
          { roomId: ws.currentRoom, before, since },
          ServerOp.History
        );
        return jsonResponse({
          roomId: data.roomId,
          messages: (data.messages || []).map(formatMessage),
          hasMore: data.hasMore,
        });
      } catch (e: any) {
        return errorResponse(`History error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_search_messages`,
    "Search messages in the current room or across all accessible rooms.",
    {
      query: z.string().min(1).max(100).describe("Search query"),
      roomId: z.string().optional().describe("Search in a specific room (default: current room)"),
    },
    async ({ query, roomId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.SearchMessages,
          { query, roomId: roomId || ws.currentRoom },
          ServerOp.SearchResults
        );
        const results = (data.messages || []).map((m: any) => ({
          id: m.id,
          author: displayName(m.authorName, m.authorId),
          content: wrapUserContent(m.content),
          roomId: m.roomId,
          createdAt: m.createdAt,
          _source: "user_message",
        }));
        return jsonResponse({ results, total: results.length });
      } catch (e: any) {
        return errorResponse(`Search error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_react`,
    "Add an emoji reaction to a message.",
    {
      messageId: z.string().describe("Message ID to react to"),
      emoji: z.string().describe("Emoji to react with"),
    },
    async ({ messageId, emoji }) => {
      const err = requireRoom(ws);
      if (err) return err;
      ws._send(ClientOp.AddReaction, {
        roomId: ws.currentRoom,
        messageId,
        emoji,
      });
      return jsonResponse(`Reacted with ${emoji} on message ${messageId}`);
    }
  );

  server.tool(
    `${P}_read_thread`,
    "Read replies in a message thread.",
    {
      messageId: z.string().describe("The parent message ID to load thread for"),
    },
    async ({ messageId }) => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.LoadThread,
          { messageId, roomId: ws.currentRoom },
          ServerOp.ThreadData
        );
        return jsonResponse({ parentId: messageId, replies: (data.messages || []).map(formatMessage) });
      } catch (e: any) {
        return errorResponse(`Thread error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_pinned`,
    "Get pinned messages in the current room.",
    {},
    async () => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.LoadPinned,
          { roomId: ws.currentRoom },
          ServerOp.PinnedMessages
        );
        const pins = (data.messages || []).map((m: any) => ({
          id: m.id,
          author: displayName(m.authorName, m.authorId),
          content: wrapUserContent(m.content),
          pinnedAt: m.pinnedAt,
          createdAt: m.createdAt,
          _source: "user_message",
        }));
        return jsonResponse({ pinnedMessages: pins });
      } catch (e: any) {
        return errorResponse(`Pinned error: ${e.message}`);
      }
    }
  );
}
