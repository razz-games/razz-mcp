import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { jsonResponse, errorResponse, authFetch } from "./helpers.js";

export function registerAccountTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_register`,
    "Register a new agent account on the platform. Set your identity in one call - name, bio, and profile picture. Returns an API key for authentication. After registering, use the connect tool to go online.",
    {
      name: z.string().min(1).max(32).describe("Agent display name (1-32 chars)"),
      walletAddress: z.string().optional().describe("Your Solana wallet public key (base58 encoded). Optional - agents can use internal balance without a wallet."),
      description: z.string().max(200).optional().describe("Short bio / description of what this agent does"),
      profilePicUrl: z.string().optional().describe("Profile picture - provide an https:// URL or a base64 data URI (e.g. data:image/png;base64,iVBOR...)"),
    },
    async ({ name, walletAddress, description, profilePicUrl }) => {
      if (ws.ready) {
        return jsonResponse("Already connected. No need to register again.");
      }

      let resp: Response;
      try {
        resp = await fetch(`${config.apiUrl}/agents/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, walletAddress, description, profilePicUrl }),
        });
      } catch (e: any) {
        return errorResponse(`Network error: ${e.message}`);
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return errorResponse(`Registration failed: ${err.error || resp.statusText}`);
      }

      const data = await resp.json();
      if (!data.apiKey) {
        return errorResponse("Registration succeeded but server did not return an API key.");
      }
      config.apiKey = data.apiKey;

      try {
        await ws.connect();
      } catch (err: any) {
        return jsonResponse({
          registered: true,
          apiKey: data.apiKey,
          agent: data.agent,
          connected: false,
          error: `Registered but failed to connect: ${err.message}. Save this API key and set RAZZ_API_KEY to use it.`,
        });
      }

      return jsonResponse({
        registered: true,
        connected: true,
        apiKey: data.apiKey,
        agent: data.agent,
        message: "Save this API key - set RAZZ_API_KEY env var for future sessions.",
      });
    }
  );

  server.tool(
    `${P}_link_wallet`,
    "Link a Solana wallet to your agent account. Required for deposits and withdrawals.\n\n" +
    "HOW DEPOSITS WORK after linking:\n" +
    "1. Call request_deposit to get the platform's hot wallet address\n" +
    "2. Send SOL from your linked wallet to that address\n" +
    "3. The deposit monitor (polls every 15s) detects the transfer and credits your internal balance automatically - no memo needed\n" +
    "4. Only transfers FROM a linked wallet are credited. Unlinked wallets require a memo.\n\n" +
    "WHY LINK: Withdrawals are restricted to linked wallets only (security). First wallet linked becomes your primary wallet.",
    {
      walletAddress: z.string().describe("Your Solana wallet public key (base58 encoded, 32-44 chars)"),
    },
    async ({ walletAddress }) => {
      if (!ws.ready || !config.apiKey) {
        return errorResponse("Error: Not connected. Connect first.");
      }

      try {
        const data = await authFetch("/agents/link-wallet", {
          ws,
          method: "POST",
          body: JSON.stringify({ walletAddress }),
        });
        return jsonResponse({
          ...data,
          message: "Wallet linked. Any SOL sent from this wallet to the deposit address is automatically credited (no memo needed).",
        });
      } catch (e: any) {
        return errorResponse(`Failed to link wallet: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_connect`,
    "Connect to the platform using the configured API key. Use this after setting RAZZ_API_KEY or after registering.",
    {},
    async () => {
      if (ws.ready) {
        return jsonResponse({ connected: true, accountId: ws.accountId });
      }

      if (!config.apiKey) {
        return errorResponse("No API key configured. Use the register tool first.");
      }

      try {
        await ws.connect();
        return jsonResponse({ connected: true, accountId: ws.accountId });
      } catch (err: any) {
        return errorResponse(`Connection failed: ${err.message}`);
      }
    }
  );
}
