import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireRoom, jsonResponse, errorResponse } from "./helpers.js";

export function registerEconomyTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_tip`,
    "Tip a user in the room you've joined. Sends tokens from your balance to another user.",
    {
      recipientId: z.string().describe("Account ID of the user to tip"),
      amount: z.number().min(0.000000001).describe("Amount to tip"),
      currency: z.string().optional().describe("Currency to tip (default: RAZZ)"),
    },
    async ({ recipientId, amount, currency }) => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        ws._send(ClientOp.Tip, {
          roomId: ws.currentRoom,
          recipientId,
          amount,
          currency: currency || "RAZZ",
        });
        const successP = ws.waitFor(ServerOp.TipNotification, 5000)
          .then((d: any) => ({ ok: true as const, data: d }));
        const errorP = ws.waitFor(ServerOp.TipError, 5000)
          .then((d: any) => ({ ok: false as const, error: d.message || "Tip failed" }));
        // Suppress unhandled rejection from the losing race
        successP.catch(() => {});
        errorP.catch(() => {});
        const result = await Promise.race([successP, errorP]);
        if (!result.ok) return errorResponse(`Tip error: ${result.error}`);
        return jsonResponse({
          tipped: true,
          recipientId: result.data.recipientId,
          recipientName: result.data.recipientName,
          amount: result.data.amount,
          currency: result.data.currency,
        });
      } catch (e: any) {
        return errorResponse(`Tip error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_rain`,
    "Rain tokens on all online users in the room you've joined. Distributes your tokens equally among everyone present.",
    {
      totalAmount: z.number().min(0.000000001).describe("Total amount to distribute"),
      currency: z.string().optional().describe("Currency to rain (default: RAZZ)"),
    },
    async ({ totalAmount, currency }) => {
      const err = requireRoom(ws);
      if (err) return err;
      try {
        ws._send(ClientOp.Rain, {
          roomId: ws.currentRoom,
          totalAmount,
          currency: currency || "RAZZ",
        });
        // Rain broadcast excludes sender, so we can't wait for RainNotification.
        // Instead: if an error occurs, RainError arrives fast. No error = success.
        const errorP = ws.waitFor(ServerOp.RainError, 2000)
          .then((d: any) => ({ ok: false as const, error: d.message || "Rain failed" }));
        const successP = new Promise<{ ok: true }>(resolve =>
          setTimeout(() => resolve({ ok: true }), 1500)
        );
        errorP.catch(() => {}); // suppress timeout rejection
        const result = await Promise.race([successP, errorP]);
        if (!result.ok) return errorResponse(`Rain error: ${result.error}`);
        return jsonResponse({
          rained: true,
          totalAmount,
          currency: currency || "RAZZ",
          roomId: ws.currentRoom,
        });
      } catch (e: any) {
        return errorResponse(`Rain error: ${e.message}`);
      }
    }
  );
}
