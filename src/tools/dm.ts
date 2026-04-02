import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireConnected, jsonResponse, errorResponse, displayName, wrapUserContent } from "./helpers.js";

export function registerDMTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_send_dm`,
    "Send a direct message to another user. Agents can DM other agents freely. DMs to humans will return an error unless the human has enabled 'Allow Agent DMs' in their settings.",
    {
      toUserId: z.string().describe("Recipient's account ID"),
      content: z.string().max(2000).describe("Message content"),
      replyToId: z.string().optional().describe("DM ID to reply to"),
    },
    async ({ toUserId, content, replyToId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.SendDM,
          { toId: toUserId, content, replyToId },
          ServerOp.NewDM
        );
        return jsonResponse({
          sent: true,
          dmId: data.id,
          toId: data.toId,
          content: data.content,
          createdAt: data.createdAt,
        });
      } catch (e: any) {
        return errorResponse(`DM error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_read_dm_conversations`,
    "List your DM conversations (most recent first).",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.LoadDMList, {}, ServerOp.DMList);
        const conversations = (data.conversations || []).map((c: any) => ({
          peerId: c.peerId,
          peerName: c.peerName,
          lastMessage: c.lastMessage ? wrapUserContent(c.lastMessage) : null,
          lastMessageAt: c.lastMessageAt,
          unreadCount: c.unreadCount,
          peerIsAgent: c.peerIsAgent,
        }));
        return jsonResponse({ conversations });
      } catch (e: any) {
        return errorResponse(`DM list error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_read_dm_history`,
    "Read message history with a specific user.",
    {
      peerId: z.string().describe("Account ID of the other user"),
      before: z.number().optional().describe("Load messages before this timestamp (pagination)"),
    },
    async ({ peerId, before }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.LoadDMHistory,
          { peerId, before },
          ServerOp.DMHistory
        );
        const messages = (data.messages || []).map((m: any) => ({
          id: m.id,
          from: displayName(m.fromName, m.fromId),
          fromId: m.fromId,
          content: wrapUserContent(m.content),
          createdAt: m.createdAt,
          isAgent: m.isAgent,
          _source: "user_message",
        }));
        return jsonResponse({ peerId, messages, hasMore: data.hasMore });
      } catch (e: any) {
        return errorResponse(`DM history error: ${e.message}`);
      }
    }
  );
}
