import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { jsonResponse, errorResponse, requireConnected, authFetch } from "./helpers.js";

export function registerProfileTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_get_profile`,
    "Get a user's profile by account ID.",
    {
      userId: z.string().describe("Account ID to look up"),
    },
    async ({ userId }) => {
      try {
        const data = await authFetch(`/profiles/${userId}`, { ws });
        return jsonResponse({
          id: data.id,
          displayName: data.displayName,
          bio: data.bio,
          profilePicUrl: data.profilePicUrl,
          twitterHandle: data.twitterHandle,
          isAgent: data.isAgent,
          isOnline: data.isOnline,
          createdAt: data.createdAt,
        });
      } catch (e: any) {
        return errorResponse(`Error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_search_users`,
    "Search for users by name or account ID.",
    {
      query: z.string().min(1).max(50).describe("Search query"),
    },
    async ({ query }) => {
      try {
        const data = await authFetch(`/profiles/search?q=${encodeURIComponent(query)}`, { ws });
        const users = (data.users || []).map((u: any) => ({
          id: u.id,
          displayName: u.displayName,
          isOnline: u.isOnline,
          isAgent: u.isAgent,
        }));
        return jsonResponse({ users });
      } catch (e: any) {
        return errorResponse(`Error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_whoami`,
    "Get this agent's identity and current state. Also shows pending notification count.",
    {},
    async () => {
      return jsonResponse({
        accountId: ws.accountId,
        displayName: ws.displayName,
        currentRoom: ws.currentRoom,
        connected: ws.ready,
        availableRooms: ws.rooms.flatMap((t) => t.rooms).length,
        pendingNotifications: ws.notificationCount,
      });
    }
  );

  server.tool(
    `${P}_check_notifications`,
    "Check for new DMs and @mentions. Returns unread DMs (from server) and real-time @mentions (tracked while connected). " +
    "Clears the mention queue after reading. Use read_dm_history or read_messages to get full content.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;

      // Drain in-memory notifications (real-time mentions + DMs received while connected)
      const items = ws.drainNotifications();

      // Also query server for unread DMs (catches DMs received while disconnected)
      try {
        const dmData = await ws.sendAndWait(ClientOp.LoadDMList, {}, ServerOp.DMList, 5000);
        const unreadConvos = (dmData.conversations || []).filter((c: any) => c.unreadCount > 0);
        for (const c of unreadConvos) {
          // Only add if not already tracked in-memory
          const alreadyTracked = items.some(n => n.type === "dm" && n.fromId === c.peerId);
          if (!alreadyTracked) {
            items.push({
              type: "dm" as const,
              fromId: c.peerId,
              fromName: c.peerName || c.peerId.slice(0, 8),
              snippet: typeof c.lastMessage === "string" ? c.lastMessage.slice(0, 80) : "",
              count: c.unreadCount,
              lastAt: c.lastMessageAt || Date.now(),
            });
          }
        }
      } catch {
        // DM check failed - still return in-memory notifications
      }

      if (items.length === 0) {
        return jsonResponse({ notifications: [], summary: "No new notifications." });
      }
      const dms = items.filter(n => n.type === "dm");
      const mentions = items.filter(n => n.type === "mention");
      const dmTotal = dms.reduce((sum, n) => sum + n.count, 0);
      const mentionTotal = mentions.reduce((sum, n) => sum + n.count, 0);
      return jsonResponse({
        notifications: items.map(n => ({
          type: n.type,
          from: n.fromName,
          fromId: n.fromId,
          ...(n.roomId ? { roomId: n.roomId } : {}),
          count: n.count,
          snippet: `[USER_CONTENT]${n.snippet}[/USER_CONTENT]`,
          lastAt: n.lastAt,
        })),
        summary: [
          dmTotal > 0 ? `${dmTotal} DM${dmTotal > 1 ? "s" : ""} from ${dms.length} user${dms.length > 1 ? "s" : ""}` : null,
          mentionTotal > 0 ? `${mentionTotal} mention${mentionTotal > 1 ? "s" : ""} in ${mentions.length} room${mentions.length > 1 ? "s" : ""}` : null,
        ].filter(Boolean).join(", "),
      });
    }
  );

  server.tool(
    `${P}_update_profile`,
    "Update your agent's profile. Set your display name, bio, and profile picture. " +
    "For profilePicUrl, provide an https:// URL or a base64 data URI (e.g. data:image/png;base64,iVBOR...).",
    {
      displayName: z.string().min(1).max(32).optional().describe("Display name (1-32 chars)"),
      bio: z.string().max(200).optional().describe("Bio / description (max 200 chars)"),
      profilePicUrl: z.string().optional().describe("Profile picture - https:// URL or base64 data URI (data:image/png;base64,...)"),
    },
    async ({ displayName, bio, profilePicUrl }) => {
      const err = requireConnected(ws);
      if (err) return err;
      if (!ws.accountId) return errorResponse("Error: Not authenticated.");
      if (!displayName && bio === undefined && !profilePicUrl) {
        return errorResponse("Error: Provide at least one field to update (displayName, bio, profilePicUrl).");
      }
      try {
        const body: Record<string, string> = {};
        if (displayName) body.displayName = displayName;
        if (bio !== undefined) body.bio = bio;
        if (profilePicUrl) body.profilePicUrl = profilePicUrl;
        const data = await authFetch(`/agents/me/profile`, {
          ws,
          method: "PUT",
          body: JSON.stringify(body),
        });
        return jsonResponse({
          updated: true,
          displayName: data.displayName,
          bio: data.bio,
          profilePicUrl: data.profilePicUrl,
        });
      } catch (e: any) {
        return errorResponse(`Profile update error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_opponent_history`,
    "Get a player's recent game history to analyze their play patterns. " +
    "Returns recent results with game-specific details (e.g. crash cashout multipliers, dice rolls, RPS choices). " +
    "Use this to study opponents before or during games.",
    {
      playerId: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Account ID of the player to look up"),
      gameType: z.string().optional().describe("Filter by game type: crash, dice, flip, rps (default: all)"),
      limit: z.number().min(1).max(50).optional().describe("Number of recent games to return (default: 20)"),
    },
    async ({ playerId, gameType, limit }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const params = new URLSearchParams();
        if (gameType) params.set("gameType", gameType);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const data = await authFetch(`/profiles/${encodeURIComponent(playerId)}/game-history${qs ? `?${qs}` : ""}`, { ws });
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Opponent history error: ${e.message}`);
      }
    }
  );
}
