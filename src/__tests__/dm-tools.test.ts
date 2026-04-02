import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RazzClient } from "../ws-client.js";
import { ClientOp, ServerOp } from "../protocol.js";
import { registerDMTools } from "../tools/dm.js";

// ─── Mock WS client ───

function createMockWs(): RazzClient {
  const ws = Object.create(RazzClient.prototype) as RazzClient;
  // Set ready state
  Object.defineProperty(ws, "ready", { get: () => true, configurable: true });
  Object.defineProperty(ws, "accountId", { value: "agent-a", configurable: true });
  Object.defineProperty(ws, "displayName", { value: "TestAgent", configurable: true });
  // Mock sendAndWait
  (ws as any).sendAndWait = vi.fn();
  return ws;
}

function createDisconnectedWs(): RazzClient {
  const ws = Object.create(RazzClient.prototype) as RazzClient;
  Object.defineProperty(ws, "ready", { get: () => false, configurable: true });
  (ws as any).sendAndWait = vi.fn();
  return ws;
}

// ─── Test helpers ───

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  // Access registered tool handlers via McpServer internals
  // _registeredTools is a plain object keyed by tool name, each with a .handler callback
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: any, extra: any) => Promise<any> }>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not registered. Available: ${Object.keys(tools).join(", ")}`);
  return tool.handler(args, {});
}

describe("MCP DM Tools", () => {
  let server: McpServer;
  let ws: RazzClient;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: "test", version: "0.0.1" });
    ws = createMockWs();
    registerDMTools(server, ws);
  });

  describe("send_dm", () => {
    it("returns error when not connected", async () => {
      const disconnectedWs = createDisconnectedWs();
      const svr = new McpServer({ name: "test", version: "0.0.1" });
      registerDMTools(svr, disconnectedWs);

      const result = await callTool(svr, "razz_send_dm", {
        toUserId: "agent-b",
        content: "hello",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not connected");
    });

    it("sends DM and returns success on happy path", async () => {
      const mockResponse = {
        id: "dm-123",
        fromId: "agent-a",
        toId: "agent-b",
        content: "hello agent",
        createdAt: 1000,
      };
      (ws.sendAndWait as any).mockResolvedValueOnce(mockResponse);

      const result = await callTool(server, "razz_send_dm", {
        toUserId: "agent-b",
        content: "hello agent",
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.dmId).toBe("dm-123");
      expect(data.toId).toBe("agent-b");
      expect(data.content).toBe("hello agent");

      // Verify correct opcode and payload
      expect(ws.sendAndWait).toHaveBeenCalledWith(
        ClientOp.SendDM,
        { toId: "agent-b", content: "hello agent", replyToId: undefined },
        ServerOp.NewDM
      );
    });

    it("passes replyToId when provided", async () => {
      (ws.sendAndWait as any).mockResolvedValueOnce({
        id: "dm-456",
        toId: "agent-b",
        content: "reply",
        createdAt: 2000,
      });

      await callTool(server, "razz_send_dm", {
        toUserId: "agent-b",
        content: "reply",
        replyToId: "dm-123",
      });

      expect(ws.sendAndWait).toHaveBeenCalledWith(
        ClientOp.SendDM,
        { toId: "agent-b", content: "reply", replyToId: "dm-123" },
        ServerOp.NewDM
      );
    });

    it("returns error on sendAndWait failure", async () => {
      (ws.sendAndWait as any).mockRejectedValueOnce(new Error("Timeout waiting for response"));

      const result = await callTool(server, "razz_send_dm", {
        toUserId: "agent-b",
        content: "hello",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Timeout");
    });

    it("returns error when server sends error", async () => {
      (ws.sendAndWait as any).mockRejectedValueOnce(new Error("Recipient not found"));

      const result = await callTool(server, "razz_send_dm", {
        toUserId: "nonexistent",
        content: "hello",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Recipient not found");
    });
  });

  describe("read_dm_conversations", () => {
    it("returns empty list when no conversations", async () => {
      (ws.sendAndWait as any).mockResolvedValueOnce({ conversations: [] });

      const result = await callTool(server, "razz_read_dm_conversations");

      const data = JSON.parse(result.content[0].text);
      expect(data.conversations).toEqual([]);
      expect(ws.sendAndWait).toHaveBeenCalledWith(
        ClientOp.LoadDMList, {}, ServerOp.DMList
      );
    });

    it("returns formatted conversations", async () => {
      (ws.sendAndWait as any).mockResolvedValueOnce({
        conversations: [
          {
            peerId: "agent-b",
            peerName: "AgentB",
            lastMessage: "hello",
            lastMessageAt: 1000,
            unreadCount: 3,
            peerIsAgent: true,
          },
        ],
      });

      const result = await callTool(server, "razz_read_dm_conversations");

      const data = JSON.parse(result.content[0].text);
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].peerId).toBe("agent-b");
      expect(data.conversations[0].unreadCount).toBe(3);
      // lastMessage should be wrapped in content tags
      expect(data.conversations[0].lastMessage).toContain("[USER_CONTENT]");
    });

    it("returns error on failure", async () => {
      (ws.sendAndWait as any).mockRejectedValueOnce(new Error("Connection lost"));

      const result = await callTool(server, "razz_read_dm_conversations");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection lost");
    });
  });

  describe("read_dm_history", () => {
    it("returns formatted messages", async () => {
      (ws.sendAndWait as any).mockResolvedValueOnce({
        messages: [
          {
            id: "dm-1",
            fromName: "AgentB",
            fromId: "agent-b",
            content: "hey there",
            createdAt: 1000,
            isAgent: true,
          },
        ],
        hasMore: false,
      });

      const result = await callTool(server, "razz_read_dm_history", {
        peerId: "agent-b",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.peerId).toBe("agent-b");
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].content).toContain("[USER_CONTENT]");
      expect(data.messages[0].fromId).toBe("agent-b");
      expect(data.hasMore).toBe(false);

      expect(ws.sendAndWait).toHaveBeenCalledWith(
        ClientOp.LoadDMHistory,
        { peerId: "agent-b", before: undefined },
        ServerOp.DMHistory
      );
    });

    it("passes pagination parameter", async () => {
      (ws.sendAndWait as any).mockResolvedValueOnce({ messages: [], hasMore: false });

      await callTool(server, "razz_read_dm_history", {
        peerId: "agent-b",
        before: 5000,
      });

      expect(ws.sendAndWait).toHaveBeenCalledWith(
        ClientOp.LoadDMHistory,
        { peerId: "agent-b", before: 5000 },
        ServerOp.DMHistory
      );
    });

    it("returns error on failure", async () => {
      (ws.sendAndWait as any).mockRejectedValueOnce(new Error("Timeout"));

      const result = await callTool(server, "razz_read_dm_history", {
        peerId: "agent-b",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Timeout");
    });
  });
});
