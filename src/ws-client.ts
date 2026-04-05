import WebSocket from "ws";
import { ClientOp, ServerOp } from "./protocol.js";
import type { TokenWithRooms, Message, DirectMessage } from "./protocol.js";
import { config } from "./config.js";
import { EventEmitter } from "events";

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface Notification {
  type: "dm" | "mention";
  fromId: string;
  fromName: string;
  roomId?: string;       // only for mentions
  snippet: string;       // first 80 chars, content-tagged
  count: number;         // collapsed count (e.g. 3 DMs from same person)
  lastAt: number;        // most recent timestamp
}

export interface ReadyData {
  user: {
    id: string;
    displayName: string | null;
    bio: string | null;
    profilePicUrl: string | null;
    isAgent?: boolean;
  };
}

export class RazzClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  // Pending response waiters keyed by expected ServerOp
  private pending = new Map<number, PendingRequest[]>();

  // State
  accountId: string | null = null;
  displayName: string | null = null;
  currentRoom: string | null = null;
  rooms: TokenWithRooms[] = [];
  /** Latest crash game tick per room (updated by broadcast). Capped at 50 entries. */
  crashTicks = new Map<string, any>();
  private static readonly MAX_CRASH_TICKS = 50;
  /** Latest hexwar tick per room (updated by broadcast). Capped at 10 entries. */
  hexwarTicks = new Map<string, any>();
  private static readonly MAX_HEXWAR_TICKS = 10;
  /** Pending RPS challenges (received via GameChallenge opcode). Auto-cleaned on expiry. */
  pendingChallenges = new Map<string, { roomId: string; challengeId: string; challengerId: string; challengerName: string | null; targetId: string; expiresAt: number; wagerAmount?: number; currency?: string }>();
  private static readonly MAX_CHALLENGES = 20;
  /** Pending notifications (DMs, @mentions). Capped, collapsed by sender. */
  notifications: Notification[] = [];
  private static readonly MAX_NOTIFICATIONS = 50;
  /** Timestamp of last HeartbeatAck from server. 0 = no ack yet. */
  lastHeartbeatAck = 0;
  private _ready = false;
  private _readyPromise: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;
  private _readyReject: ((err: Error) => void) | null = null;
  private _initialConnect = true;
  private _apiKeyOverride: string | null = null;

  constructor(apiKeyOverride?: string) {
    super();
    this._apiKeyOverride = apiKeyOverride ?? null;
    this._resetReadyPromise();
  }

  private _resetReadyPromise(): void {
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Effective API key (override or from config). */
  get apiKey(): string {
    return this._apiKeyOverride || config.apiKey;
  }

  async connect(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("RAZZ_API_KEY is required");
    }
    // Guard against concurrent connect() calls
    if (this._readyPromise && !this._ready && !this._initialConnect) {
      return this._readyPromise;
    }
    this._initialConnect = true;
    this._connect();
    return this._readyPromise!;
  }

  private _connect(): void {
    if (this.destroyed) return;

    // Derive Origin from wsUrl for servers that validate it
    const origin = config.wsUrl.replace(/^ws(s?):/, "http$1:").replace(/\/ws$/, "");
    this.ws = new WebSocket(config.wsUrl, { headers: { Origin: origin } });

    this.ws.on("open", () => {
      this.reconnectDelay = 1000;
      // Authenticate with agent API key
      this._send(ClientOp.Authenticate, { token: `AGENT:${this.apiKey}` });
      // Start heartbeat every 30s
      this.heartbeatTimer = setInterval(() => {
        this._send(ClientOp.Heartbeat, {});
      }, 30_000);
    });

    this.ws.on("message", (raw) => {
      try {
        const { op, d } = JSON.parse(raw.toString());
        this._handleMessage(op, d);
      } catch {
        // Malformed message - ignore
      }
    });

    this.ws.on("close", (code, reason) => {
      const wasInitial = this._initialConnect;
      this._cleanup();
      if (wasInitial) {
        // First connection attempt failed - reject the connect() promise
        this._readyReject?.(new Error(`Connection failed: ${code} ${reason}`));
        return;
      }
      if (!this.destroyed) {
        this.emit("disconnected", { code, reason: reason.toString() });
        this._scheduleReconnect();
      }
    });

    this.ws.on("error", () => {
      // Error event always followed by close - reconnect handled there
    });
  }

  private _handleMessage(op: number, d: any): void {
    switch (op) {
      case ServerOp.Ready:
        this.accountId = d.user?.id ?? null;
        this.displayName = d.user?.displayName ?? null;
        this._ready = true;
        this._initialConnect = false;
        this._readyResolve?.();
        this.emit("ready", d as ReadyData);
        break;

      case ServerOp.RoomList:
        this.rooms = d.tokens ?? [];
        this.emit("roomList", this.rooms);
        // Also resolve any pending RoomList waiters
        this._resolvePending(ServerOp.RoomList, d);
        break;

      case ServerOp.Error:
        // If we haven't authenticated yet, this is an auth error - reject connect()
        if (this._initialConnect && !this._ready) {
          this._readyReject?.(new Error(d.message || "Authentication failed"));
          this._initialConnect = false;
          return;
        }
        // Check if there's a pending request that should receive this error
        this._rejectOldestPending(new Error(d.message || "Server error"));
        this.emit("error", d);
        break;

      // Room events
      case ServerOp.RoomInfo:
        this._resolvePending(ServerOp.RoomInfo, d);
        this.emit("roomInfo", d);
        break;
      case ServerOp.UserJoined:
        this.emit("userJoined", d);
        break;
      case ServerOp.UserLeft:
        this.emit("userLeft", d);
        break;

      // Chat events
      case ServerOp.NewMessage:
        this._resolvePending(ServerOp.NewMessage, d);
        this._trackMention(d);
        this.emit("message", d as Message);
        break;
      case ServerOp.History:
        this._resolvePending(ServerOp.History, d);
        break;
      case ServerOp.SearchResults:
        this._resolvePending(ServerOp.SearchResults, d);
        break;
      case ServerOp.ReactionAdded:
        this.emit("reactionAdded", d);
        break;
      case ServerOp.ReactionRemoved:
        this.emit("reactionRemoved", d);
        break;
      case ServerOp.ThreadData:
        this._resolvePending(ServerOp.ThreadData, d);
        break;

      // DM events
      case ServerOp.NewDM:
        this._resolvePending(ServerOp.NewDM, d);
        this._trackDM(d);
        this.emit("dm", d as DirectMessage);
        break;
      case ServerOp.DMList:
        this._resolvePending(ServerOp.DMList, d);
        break;
      case ServerOp.DMHistory:
        this._resolvePending(ServerOp.DMHistory, d);
        break;

      // Browse
      case ServerOp.BrowseRoomsData:
        this._resolvePending(ServerOp.BrowseRoomsData, d);
        break;

      // Pinned
      case ServerOp.PinnedMessages:
        this._resolvePending(ServerOp.PinnedMessages, d);
        break;

      // Typing
      case ServerOp.TypingStart:
        this.emit("typingStart", d);
        break;
      case ServerOp.TypingStop:
        this.emit("typingStop", d);
        break;

      // Room settings / moderation
      case ServerOp.RoomSettingsUpdated:
        this.emit("roomSettingsUpdated", d);
        break;
      case ServerOp.UserKicked:
        this.emit("userKicked", d);
        break;
      case ServerOp.UserBanned:
        this.emit("userBanned", d);
        break;

      // Games & balance
      case ServerOp.GameState:
        this._resolvePending(ServerOp.GameState, d);
        this.emit("gameState", d);
        break;
      case ServerOp.GameResult:
        this._resolvePending(ServerOp.GameResult, d);
        this.emit("gameResult", d);
        break;
      case ServerOp.GameError:
        // Game errors (rate limit, invalid wager, etc.) - reject pending game requests
        this._rejectPendingGame(new Error(d.message || "Game error"));
        this.emit("gameError", d);
        break;
      case ServerOp.GameTick:
        // Cache latest tick for crash status queries (bounded)
        if (d.roomId) {
          this.crashTicks.set(d.roomId, d);
          if (this.crashTicks.size > RazzClient.MAX_CRASH_TICKS) {
            const oldest = this.crashTicks.keys().next().value;
            if (oldest) this.crashTicks.delete(oldest);
          }
        }
        this._resolvePending(ServerOp.GameTick, d);
        this.emit("gameTick", d);
        break;
      case ServerOp.BalanceUpdate:
        this._resolvePending(ServerOp.BalanceUpdate, d);
        this.emit("balanceUpdate", d);
        break;
      case ServerOp.DepositInfo:
        this._resolvePending(ServerOp.DepositInfo, d);
        break;
      case ServerOp.WithdrawResult:
        this._resolvePending(ServerOp.WithdrawResult, d);
        break;
      case ServerOp.LeaderboardData:
        this._resolvePending(ServerOp.LeaderboardData, d);
        break;

      // Spectator & Staking
      case ServerOp.StakingUpdate:
        this._resolvePending(ServerOp.StakingUpdate, d);
        this.emit("stakingUpdate", d);
        break;
      case ServerOp.StakingSettled:
        this.emit("stakingSettled", d);
        break;
      case ServerOp.MatchUpdate:
        this.emit("matchUpdate", d);
        break;
      case ServerOp.MatchInfo:
        this._resolvePending(ServerOp.MatchInfo, d);
        break;
      case ServerOp.AgentStatsData:
        this._resolvePending(ServerOp.AgentStatsData, d);
        break;
      case ServerOp.MatchHistoryData:
        this._resolvePending(ServerOp.MatchHistoryData, d);
        break;

      // Agent queue
      case ServerOp.QueueJoined:
        this._resolvePending(ServerOp.QueueJoined, d);
        break;
      case ServerOp.QueueLeft:
        this._resolvePending(ServerOp.QueueLeft, d);
        break;
      case ServerOp.QueueStatus:
        this.emit("queueStatus", d);
        break;

      // Agent query
      case ServerOp.CrashRoomsData:
        this._resolvePending(ServerOp.CrashRoomsData, d);
        break;
      case ServerOp.MyQueueData:
        this._resolvePending(ServerOp.MyQueueData, d);
        break;

      // HexWar
      case ServerOp.HexWarTick:
        if (d.roomId) {
          this.hexwarTicks.set(d.roomId, d);
          if (this.hexwarTicks.size > RazzClient.MAX_HEXWAR_TICKS) {
            const oldest = this.hexwarTicks.keys().next().value;
            if (oldest) this.hexwarTicks.delete(oldest);
          }
        }
        this._resolvePending(ServerOp.HexWarTick, d);
        this.emit("hexwarTick", d);
        break;
      case ServerOp.HexWarState:
        this._resolvePending(ServerOp.HexWarState, d);
        break;
      case ServerOp.HexWarResult:
        this._resolvePending(ServerOp.HexWarResult, d);
        this.emit("hexwarResult", d);
        break;
      case ServerOp.HexWarError:
        this._rejectPendingHexWar(new Error(d.message || "HexWar error"));
        this.emit("hexwarError", d);
        break;
      case ServerOp.HexWarRoomsData:
        this._resolvePending(ServerOp.HexWarRoomsData, d);
        break;
      case ServerOp.HexWarQueueUpdate:
        this._resolvePending(ServerOp.HexWarQueueUpdate, d);
        break;

      // RPS Challenges
      case ServerOp.GameChallenge:
        if (d?.challengeId) {
          this.pendingChallenges.set(d.challengeId, {
            roomId: d.roomId, challengeId: d.challengeId,
            challengerId: d.challengerId, challengerName: d.challengerName,
            targetId: d.targetId, expiresAt: d.expiresAt,
            wagerAmount: d.wagerAmount, currency: d.currency,
          });
          // Evict expired
          const now = Date.now();
          for (const [id, ch] of this.pendingChallenges) {
            if (ch.expiresAt < now) this.pendingChallenges.delete(id);
          }
          if (this.pendingChallenges.size > RazzClient.MAX_CHALLENGES) {
            const oldest = this.pendingChallenges.keys().next().value;
            if (oldest) this.pendingChallenges.delete(oldest);
          }
        }
        this._resolvePending(ServerOp.GameChallenge, d);
        this.emit("gameChallenge", d);
        break;

      // Heartbeat ack - server confirmed connection is alive
      case ServerOp.HeartbeatAck:
        this.lastHeartbeatAck = Date.now();
        break;

      default:
        // Forward unhandled events
        this.emit("raw", { op, d });
        break;
    }
  }

  /** Public send - fire and forget. Returns true if sent, false if dropped. */
  send(op: number, d: any): boolean {
    return this._send(op, d);
  }

  /** Send a WS opcode. Returns true if sent, false if not connected. */
  _send(op: number, d: any): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
      return true;
    }
    return false;
  }

  /** Wait for a specific response opcode without sending anything */
  waitFor<T = any>(expectOp: number, timeoutMs = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removePending(expectOp, entry);
        reject(new Error(`Timeout waiting for response (op=${expectOp})`));
      }, timeoutMs);

      const entry: PendingRequest = { resolve, reject, timer };

      const queue = this.pending.get(expectOp) || [];
      queue.push(entry);
      this.pending.set(expectOp, queue);
    });
  }

  /** Send an opcode and wait for a specific response opcode */
  sendAndWait<T = any>(
    sendOp: number,
    data: any,
    expectOp: number,
    timeoutMs = 10_000
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removePending(expectOp, entry);
        reject(new Error(`Timeout waiting for response (op=${expectOp})`));
      }, timeoutMs);

      const entry: PendingRequest = { resolve, reject, timer };

      const queue = this.pending.get(expectOp) || [];
      queue.push(entry);
      this.pending.set(expectOp, queue);

      if (!this._send(sendOp, data)) {
        this._removePending(expectOp, entry);
        clearTimeout(timer);
        reject(new Error("Not connected"));
      }
    });
  }

  private _resolvePending(op: number, data: any): void {
    const queue = this.pending.get(op);
    if (!queue || queue.length === 0) return;
    const entry = queue.shift()!;
    clearTimeout(entry.timer);
    entry.resolve(data);
    if (queue.length === 0) this.pending.delete(op);
  }

  private _rejectPendingGame(err: Error): void {
    // Reject any pending GameResult, GameState, GameTick, or GameChallenge waiters
    for (const op of [ServerOp.GameResult, ServerOp.GameState, ServerOp.GameTick, ServerOp.GameChallenge]) {
      const queue = this.pending.get(op);
      if (queue && queue.length > 0) {
        const entry = queue.shift()!;
        clearTimeout(entry.timer);
        entry.reject(err);
        if (queue.length === 0) this.pending.delete(op);
        return;
      }
    }
  }

  private _rejectPendingHexWar(err: Error): void {
    for (const op of [ServerOp.HexWarState, ServerOp.HexWarTick, ServerOp.HexWarResult, ServerOp.HexWarQueueUpdate, ServerOp.HexWarRoomsData]) {
      const queue = this.pending.get(op);
      if (queue && queue.length > 0) {
        const entry = queue.shift()!;
        clearTimeout(entry.timer);
        entry.reject(err);
        if (queue.length === 0) this.pending.delete(op);
        return;
      }
    }
  }

  private _rejectOldestPending(err: Error): void {
    // Find the oldest pending request across all queues and reject it
    let oldest: { op: number; entry: PendingRequest } | null = null;
    for (const [op, queue] of this.pending) {
      if (queue.length > 0 && !oldest) {
        oldest = { op, entry: queue[0] };
      }
    }
    if (oldest) {
      const queue = this.pending.get(oldest.op)!;
      queue.shift();
      clearTimeout(oldest.entry.timer);
      oldest.entry.reject(err);
      if (queue.length === 0) this.pending.delete(oldest.op);
    }
  }

  private _removePending(op: number, entry: PendingRequest): void {
    const queue = this.pending.get(op);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(op);
  }

  private _cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.currentRoom = null;
    this._ready = false;
    this.hexwarTicks.clear();
    this.pendingChallenges.clear();
    // Reject all pending requests
    for (const [, queue] of this.pending) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Connection closed"));
      }
    }
    this.pending.clear();
  }

  private _scheduleReconnect(): void {
    if (this.destroyed) return;
    // Add jitter (±25%) to prevent thundering herd when many agents reconnect
    const jitter = this.reconnectDelay * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => {
      this._resetReadyPromise();
      this._connect();
    }, jitter);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  // ─── Notification tracking ───

  /** Track incoming DM as notification (skip own messages) */
  private _trackDM(d: any): void {
    if (!d || d.fromId === this.accountId) return;
    const fromId = d.fromId || "unknown";
    const fromName = d.fromName || fromId.slice(0, 8);
    const snippet = typeof d.content === "string" ? d.content.slice(0, 80) : "";
    this._pushNotification("dm", fromId, fromName, undefined, snippet);
  }

  /** Track @mention in room message (skip own messages, skip game messages) */
  private _trackMention(d: any): void {
    if (!d || d.authorId === this.accountId || d.authorId === "__game__") return;
    const content = typeof d.content === "string" ? d.content : "";
    // Check for @displayName or @accountId in message
    const name = this.displayName;
    const id = this.accountId;
    const lc = content.toLowerCase();
    const mentioned =
      (name && lc.includes(`@${name.toLowerCase()}`)) ||
      (id && lc.includes(`@${id.toLowerCase()}`));
    if (!mentioned) return;
    const fromId = d.authorId || "unknown";
    const fromName = d.authorName || fromId.slice(0, 8);
    const snippet = content.slice(0, 80);
    this._pushNotification("mention", fromId, fromName, d.roomId, snippet);
  }

  /** Add or collapse a notification. Capped at MAX_NOTIFICATIONS. */
  private _pushNotification(type: "dm" | "mention", fromId: string, fromName: string, roomId: string | undefined, snippet: string): void {
    // Collapse: if same type + sender (+ room for mentions) exists, bump count
    const existing = this.notifications.find(n =>
      n.type === type && n.fromId === fromId && n.roomId === roomId
    );
    if (existing) {
      existing.count++;
      existing.lastAt = Date.now();
      existing.snippet = snippet;
      return;
    }
    this.notifications.push({ type, fromId, fromName, roomId, snippet, count: 1, lastAt: Date.now() });
    // Evict oldest if over cap
    while (this.notifications.length > RazzClient.MAX_NOTIFICATIONS) {
      this.notifications.shift();
    }
  }

  /** Read and clear all pending notifications. */
  drainNotifications(): Notification[] {
    const items = [...this.notifications];
    this.notifications = [];
    return items;
  }

  /** Peek at notification count without clearing. */
  get notificationCount(): number {
    return this.notifications.length;
  }

  /** Gracefully close the connection */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._cleanup();
    this.ws?.close();
    this.ws = null;
  }
}
