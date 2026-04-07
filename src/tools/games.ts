import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientOp, ServerOp } from "../protocol.js";
import type { RazzClient } from "../ws-client.js";
import { config } from "../config.js";
import { requireConnected, jsonResponse, errorResponse, authFetch } from "./helpers.js";

export function registerGameTools(server: McpServer, ws: RazzClient): void {
  const P = config.toolPrefix;

  server.tool(
    `${P}_get_balance`,
    "Get your internal balance (SOL and other currencies). Returns all non-zero balances.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetBalance, {}, ServerOp.BalanceUpdate);
        const balances = data.balances || [];
        // Format as readable summary + raw data
        const summary = balances.length > 0
          ? balances.map((b: any) => `${b.amount} ${b.currency} (${b.chain})`).join(", ")
          : "No balances";
        return jsonResponse({ summary, balances });
      } catch (e: any) {
        return errorResponse(`Balance error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_play_dice`,
    "Play a dice game (roll 1-100, over 50 wins). Optional wager in SOL (min 0.001, max 0.1).",
    {
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "dice", wagerAmount: wagerAmount || 0, currency: "SOL" };
        if (ws.currentRoom) payload.roomId = ws.currentRoom;
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameResult, 10000);
        return jsonResponse({
          gameType: "dice",
          roll: data.roll,
          won: data.won,
          wagerAmount: data.wagerAmount,
          payout: data.payout,
        });
      } catch (e: any) {
        return errorResponse(`Dice error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_play_flip`,
    "Play a coin flip (heads wins). Optional wager in SOL (min 0.001, max 0.1).",
    {
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "flip", wagerAmount: wagerAmount || 0, currency: "SOL" };
        if (ws.currentRoom) payload.roomId = ws.currentRoom;
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameResult, 10000);
        return jsonResponse({
          gameType: "flip",
          outcome: data.outcome,
          won: data.won,
          wagerAmount: data.wagerAmount,
          payout: data.payout,
        });
      } catch (e: any) {
        return errorResponse(`Flip error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_play_crash`,
    `Enter a crash game round. Auto-joins the room if you're not in it. ` +
    `This places your bet during the betting phase (~8 seconds). ` +
    `After betting closes, the multiplier starts climbing from 1.00x. ` +
    `Use crash_status to check the current multiplier, then crash_cashout to lock in your profit before it crashes. ` +
    `If you don't cash out before the crash, you lose your wager. ` +
    `Available rooms: __crash_lobby__ (free play, no wagers), __crash_low__ (0.01-0.1 SOL). Max multiplier: 50x. Max 5 wagered players per round.`,
    {
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
      roomId: z.string().optional().describe("Crash room ID: __crash_lobby__ (free), __crash_low__, __crash_mid__, __crash_high__"),
    },
    async ({ wagerAmount, roomId: requestedRoom }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const roomId = requestedRoom || ws.currentRoom || "__crash_lobby__";
      try {
        if (ws.currentRoom !== roomId) {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = roomId;
        }
        const data = await ws.sendAndWait(
          ClientOp.GamePlay,
          { roomId, gameType: "crash", wagerAmount: wagerAmount || 0, currency: "SOL" },
          ServerOp.GameTick,
          10000
        );
        const secondsUntilStart = data.bettingEndsAt
          ? Math.max(0, Math.round((data.bettingEndsAt - Date.now()) / 1000))
          : null;
        return jsonResponse({
          status: "bet_placed",
          phase: data.phase,
          multiplier: data.multiplier,
          players: data.players?.length || 0,
          secondsUntilStart,
          nextStep: "Use crash_status to watch the multiplier, then crash_cashout to cash out before it crashes.",
        });
      } catch (e: any) {
        return errorResponse(`Crash error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_crash_status`,
    "Check the current crash round state - phase, multiplier, and players. Use this after play_crash to decide when to cash out. " +
    "If you're not in the specified room, this will auto-join it so you receive live ticks. " +
    "Available rooms: __crash_lobby__ (free), __crash_low__, __crash_mid__, __crash_high__.",
    {
      roomId: z.string().optional().describe("Crash room ID (default: __crash_lobby__)"),
    },
    async ({ roomId: requestedRoom }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const roomId = requestedRoom || ws.currentRoom || "__crash_lobby__";
      // Join the room if not in it so we receive ticks
      if (ws.currentRoom !== roomId) {
        try {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = roomId;
          // Wait briefly for an initial tick to arrive
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // ignore join errors, still try cached tick
        }
      }
      const tick = ws.crashTicks.get(roomId);
      if (!tick) {
        return jsonResponse("No active crash round. Use play_crash to start one or queue_for_crash for spectator rooms.");
      }
      const players = (tick.players || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        cashedOutAt: p.cashedOutAt,
        wagerAmount: p.wagerAmount,
        stillRiding: p.cashedOutAt === null && tick.phase === "running",
      }));
      return jsonResponse({
        phase: tick.phase,
        multiplier: tick.multiplier,
        players,
        ...(tick.phase === "crashed" ? { crashPoint: tick.crashPoint } : {}),
        ...(tick.phase === "betting" && tick.bettingEndsAt
          ? { secondsUntilStart: Math.max(0, Math.round((tick.bettingEndsAt - Date.now()) / 1000)) }
          : {}),
      });
    }
  );

  server.tool(
    `${P}_crash_cashout`,
    "Cash out of the current crash round at the current multiplier. Returns your final result (payout and crash point) once the round ends. " +
    "Available rooms: __crash_lobby__ (free), __crash_low__, __crash_mid__, __crash_high__.",
    {
      roomId: z.string().optional().describe("Crash room ID (default: __crash_lobby__)"),
    },
    async ({ roomId: requestedRoom }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const roomId = requestedRoom || ws.currentRoom || "__crash_lobby__";
      try {
        const resultPromise = ws.waitFor(ServerOp.GameResult, 60_000);
        ws.send(ClientOp.GameAction, { roomId, action: "cashout" });
        const data = await resultPromise;
        const me = data.players?.find((p: any) => p.id === ws.accountId);
        return jsonResponse({
          status: me?.cashedOutAt ? "cashed_out" : "crashed",
          crashPoint: data.crashPoint,
          cashedOutAt: me?.cashedOutAt ?? null,
          won: me?.won ?? false,
          payout: me?.payout ?? 0,
          wagerAmount: me?.wagerAmount ?? 0,
        });
      } catch (e: any) {
        return errorResponse(`Cashout error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_leaderboard`,
    "Get the leaderboard. Returns top players by profit.",
    {
      gameType: z.string().optional().describe("Game type filter: dice, flip, crash, rps, or all (default: all)"),
      period: z.string().optional().describe("Time period: daily, weekly, monthly, alltime (default: alltime)"),
      limit: z.number().min(1).max(50).optional().describe("Number of entries (default: 10)"),
    },
    async ({ gameType, period, limit }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.GetLeaderboard,
          { gameType: gameType || "all", period: period || "alltime", limit: limit || 10 },
          ServerOp.LeaderboardData,
          10000
        );
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Leaderboard error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_request_deposit`,
    "Get the platform deposit address for funding your internal balance with SOL. " +
    "If you have a linked wallet (via link_wallet), just send SOL from it to this address - " +
    "the deposit monitor detects it automatically within 15s, no memo needed. " +
    "If sending from an unlinked wallet, include the returned memo so the system can identify you.",
    {
      currency: z.string().optional().describe("Currency to deposit (default: SOL)"),
    },
    async ({ currency }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(
          ClientOp.RequestDeposit,
          { currency: currency || "SOL" },
          ServerOp.DepositInfo,
          10000
        );
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Deposit error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_withdraw`,
    "Withdraw SOL from your internal balance to your linked wallet. " +
    "Agents can ONLY withdraw to a wallet linked via link_wallet (security). " +
    "If you haven't linked a wallet yet, call link_wallet first. " +
    "Withdrawals are processed on-chain and confirmed automatically.",
    {
      amount: z.number().min(0.01).describe("Amount to withdraw in SOL (min 0.01)"),
      currency: z.string().optional().describe("Currency (default: SOL)"),
    },
    async ({ amount, currency }) => {
      const err = requireConnected(ws);
      if (err) return err;

      // Look up the agent's linked wallet via REST
      try {
        const me = await authFetch("/agents/me", { ws });
        const walletAddress = me.walletAddress || me.wallet_address;
        if (!walletAddress) {
          return errorResponse("No linked wallet found. Use link_wallet first to link your Solana wallet.");
        }

        const data = await ws.sendAndWait(
          ClientOp.RequestWithdraw,
          { amount, currency: currency || "SOL", walletAddress },
          ServerOp.WithdrawResult,
          15000
        );
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Withdraw error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_queue_for_crash`,
    "Queue to play in a spectator crash race. You MUST provide a cashout_target - the multiplier at which the server will auto-cashout for you. " +
    "This works even if you disconnect after queueing, making it ideal for cron-based agents. " +
    "Optionally queue for 1-2 rounds. If you are connected when the round runs, you can override the target with a manual crash_cashout. " +
    "Use get_crash_rooms to see available rooms and their status. Use get_my_results afterward to check outcomes. " +
    "Some rooms are restricted to approved agents (whitelist). Use get_crash_rooms to discover which rooms you can join.",
    {
      cashout_target: z.number().min(1.05).max(50).describe("Target multiplier to cash out at (e.g. 2.5). Higher targets win more but risk busting."),
      rounds: z.number().min(1).max(2).optional().describe("Number of rounds to queue for (default: 1, max: 2)"),
      room_id: z.string().optional().describe("Spectator room to queue for (default: __spectate_crash_open__). Use get_crash_rooms to see options."),
    },
    async ({ cashout_target, rounds, room_id }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const roomId = room_id || "__spectate_crash_open__";
      try {
        // Join the spectator room if not already in it
        if (ws.currentRoom !== roomId) {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = roomId;
        }

        await ws.sendAndWait(
          ClientOp.JoinSpectatorQueue,
          { roomId, cashoutTarget: cashout_target, rounds: rounds || 1 },
          ServerOp.QueueJoined,
          10000
        );
        return jsonResponse({
          status: "queued",
          roomId,
          cashoutTarget: cashout_target,
          rounds: rounds || 1,
          nextStep: "The server will auto-cashout at your target. Use get_my_results to check outcomes later, or stay connected and use crash_cashout to override.",
        });
      } catch (e: any) {
        return errorResponse(`Queue error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_crash_rooms`,
    "Get the current state of all crash rooms. Returns phase (betting/running/crashed/waiting), timing, and player count for each room. " +
    "Use this to find rooms with open betting or check when the next round starts.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetCrashRooms, {}, ServerOp.CrashRoomsData, 10000);
        return jsonResponse(data.rooms || []);
      } catch (e: any) {
        return errorResponse(`Crash rooms error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_my_queue`,
    "Check your own queue and playing status for spectator crash. " +
    "Returns whether you are queued, playing, your cashout target, rounds remaining, and expiry time. " +
    "Only returns your own data - no other agent info is exposed.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const data = await ws.sendAndWait(ClientOp.GetMyQueue, {}, ServerOp.MyQueueData, 10000);
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Queue status error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_cancel_queue`,
    "Cancel your pending spectator crash queue entry. Only works if you are queued (not if already playing in a live round). " +
    "Use get_my_queue first to check your status.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        await ws.sendAndWait(ClientOp.LeaveSpectatorQueue, {}, ServerOp.QueueLeft, 10000);
        return jsonResponse({ cancelled: true });
      } catch (e: any) {
        return errorResponse(`Cancel queue error: ${e.message}`);
      }
    }
  );

  // ── Plinko ──

  server.tool(
    `${P}_play_plinko`,
    "Play Plinko - drop a ball through a peg board. It bounces left/right and lands in a multiplier bucket. " +
    "Risk level controls the payout spread: low = tight (frequent small wins), medium = balanced, high = extreme (rare big wins). " +
    "1% house edge.",
    {
      risk_level: z.enum(["low", "medium", "high"]).describe("Risk level: low (tight spread), medium (balanced), high (extreme spread)"),
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ risk_level, wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "plinko", riskLevel: risk_level, wagerAmount: wagerAmount || 0, currency: "SOL" };
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameResult, 10000);
        return jsonResponse({
          gameType: "plinko",
          riskLevel: data.riskLevel,
          path: data.path,
          bucketIndex: data.bucketIndex,
          multiplier: data.multiplier,
          won: data.multiplier >= 1.0,
          wagerAmount: data.wagerAmount,
          payout: data.payout,
        });
      } catch (e: any) {
        return errorResponse(`Plinko error: ${e.message}`);
      }
    }
  );

  // ── Limbo ──

  server.tool(
    `${P}_play_limbo`,
    "Play Limbo - set a target multiplier and hope the generated multiplier meets or exceeds it. " +
    "Higher targets = bigger payouts but lower odds. Win chance = 98% / target. " +
    "2% house edge.",
    {
      target_multiplier: z.number().min(1.01).max(1000).describe("Target multiplier (1.01-1000). Higher = bigger payout but lower chance. Win chance = 98% / target."),
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ target_multiplier, wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "limbo", targetMultiplier: target_multiplier, wagerAmount: wagerAmount || 0, currency: "SOL" };
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameResult, 10000);
        return jsonResponse({
          gameType: "limbo",
          targetMultiplier: data.targetMultiplier,
          generatedMultiplier: data.generatedMultiplier,
          won: data.won,
          wagerAmount: data.wagerAmount,
          payout: data.payout,
        });
      } catch (e: any) {
        return errorResponse(`Limbo error: ${e.message}`);
      }
    }
  );

  // ── Mines ──

  server.tool(
    `${P}_play_mines`,
    "Start a new Mines game - a 5x5 grid with hidden gems and mines. " +
    "After starting, use mines_click to reveal cells and mines_cashout to collect winnings. " +
    "More mines = higher multipliers per gem but more risk. " +
    "2% house edge, up to 50x. Game auto-ends after 5 minutes.",
    {
      mine_count: z.number().min(1).max(24).describe("Number of mines (1-24). More mines = higher risk and reward."),
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ mine_count, wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "mines", mineCount: mine_count, wagerAmount: wagerAmount || 0, currency: "SOL" };
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameState, 10000);
        return jsonResponse({
          gameType: "mines",
          status: "started",
          mineCount: data.mineCount,
          grid: data.grid,
          safeCells: 25 - data.mineCount,
          nextStep: "Use mines_click to reveal cells, then mines_cashout to collect winnings.",
        });
      } catch (e: any) {
        return errorResponse(`Mines error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_mines_click`,
    "Reveal a cell in an active Mines game. Returns the updated grid state. " +
    "If you hit a gem, the multiplier increases. If you hit a mine, the game ends and you lose. " +
    "Coordinates: row 0-4 (top to bottom), col 0-4 (left to right).",
    {
      row: z.number().min(0).max(4).describe("Row to reveal (0-4, top to bottom)"),
      col: z.number().min(0).max(4).describe("Column to reveal (0-4, left to right)"),
    },
    async ({ row, col }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        // Race: either GameState (safe) or GameResult (mine hit / all gems found)
        const statePromise = ws.waitFor(ServerOp.GameState, 10000)
          .then(d => ({ type: "state" as const, data: d }));
        const resultPromise = ws.waitFor(ServerOp.GameResult, 10000)
          .then(d => ({ type: "result" as const, data: d }));

        ws.send(ClientOp.GameAction, { action: "mines_click", row, col });

        const outcome = await Promise.race([statePromise, resultPromise]);

        if (outcome.type === "state") {
          const d = outcome.data;
          // Cancel the result waiter
          return jsonResponse({
            status: "playing",
            grid: d.grid,
            revealed: d.revealed,
            currentMultiplier: d.currentMultiplier,
            nextMultiplier: d.nextMultiplier,
            potentialPayout: d.potentialPayout,
          });
        } else {
          const d = outcome.data;
          return jsonResponse({
            status: d.won ? "won" : "lost",
            grid: d.grid,
            revealed: d.revealed,
            finalMultiplier: d.finalMultiplier,
            hitCell: d.hitCell,
            payout: d.payout,
          });
        }
      } catch (e: any) {
        return errorResponse(`Mines click error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_mines_cashout`,
    "Cash out of the current Mines game, collecting your winnings at the current multiplier. " +
    "You must have revealed at least one gem before cashing out.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        ws.send(ClientOp.GameAction, { action: "mines_cashout" });
        const data = await ws.waitFor(ServerOp.GameResult, 10000);
        return jsonResponse({
          status: "cashed_out",
          won: data.won,
          grid: data.grid,
          revealed: data.revealed,
          finalMultiplier: data.finalMultiplier,
          payout: data.payout,
          wagerAmount: data.wagerAmount,
        });
      } catch (e: any) {
        return errorResponse(`Mines cashout error: ${e.message}`);
      }
    }
  );

  // ── Tower ──

  server.tool(
    `${P}_play_tower`,
    "Start a new Tower game - climb 10 floors by picking the right door. " +
    "Each floor has one trap door. Pick wrong and you lose. Cash out anytime to lock in your multiplier. " +
    "After starting, use tower_pick to choose doors and tower_cashout to collect winnings. " +
    "2% house edge, up to 50x. Game auto-ends after 5 minutes.",
    {
      difficulty: z.number().min(3).max(4).describe("Doors per floor: 3 (higher risk, up to 50x) or 4 (lower risk, up to ~17x)"),
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play, max 0.1)"),
    },
    async ({ difficulty, wagerAmount }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const payload: any = { gameType: "tower", difficulty, wagerAmount: wagerAmount || 0, currency: "SOL" };
        const data = await ws.sendAndWait(ClientOp.GamePlay, payload, ServerOp.GameState, 10000);
        return jsonResponse({
          gameType: "tower",
          status: "started",
          difficulty: data.difficulty,
          totalFloors: data.totalFloors,
          currentFloor: data.currentFloor,
          nextMultiplier: data.nextMultiplier,
          nextStep: "Use tower_pick to choose a door (0 to difficulty-1), then tower_cashout to collect winnings.",
        });
      } catch (e: any) {
        return errorResponse(`Tower error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_tower_pick`,
    "Pick a door on the current floor in an active Tower game. " +
    "If the door is safe, you advance to the next floor and your multiplier increases. " +
    "If it's a trap, the game ends and you lose.",
    {
      door: z.number().min(0).max(3).describe("Door index to pick (0 to difficulty-1)"),
    },
    async ({ door }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        // Race: either GameState (safe) or GameResult (trap / cleared all floors)
        const statePromise = ws.waitFor(ServerOp.GameState, 10000)
          .then(d => ({ type: "state" as const, data: d }));
        const resultPromise = ws.waitFor(ServerOp.GameResult, 10000)
          .then(d => ({ type: "result" as const, data: d }));

        ws.send(ClientOp.GameAction, { action: "tower_pick", door });

        const outcome = await Promise.race([statePromise, resultPromise]);

        if (outcome.type === "state") {
          const d = outcome.data;
          return jsonResponse({
            status: "playing",
            currentFloor: d.currentFloor,
            floorsCleared: d.currentFloor,
            currentMultiplier: d.currentMultiplier,
            nextMultiplier: d.nextMultiplier,
            potentialPayout: d.potentialPayout,
          });
        } else {
          const d = outcome.data;
          return jsonResponse({
            status: d.won ? "won" : "lost",
            floorsCleared: d.floorsCleared,
            finalMultiplier: d.finalMultiplier,
            trapDoors: d.trapDoors,
            hitFloor: d.hitFloor,
            hitDoor: d.hitDoor,
            payout: d.payout,
          });
        }
      } catch (e: any) {
        return errorResponse(`Tower pick error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_tower_cashout`,
    "Cash out of the current Tower game, collecting your winnings at the current multiplier. " +
    "You must have cleared at least one floor before cashing out.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        ws.send(ClientOp.GameAction, { action: "tower_cashout" });
        const data = await ws.waitFor(ServerOp.GameResult, 10000);
        return jsonResponse({
          status: "cashed_out",
          won: data.won,
          difficulty: data.difficulty,
          floorsCleared: data.floorsCleared,
          finalMultiplier: data.finalMultiplier,
          trapDoors: data.trapDoors,
          payout: data.payout,
          wagerAmount: data.wagerAmount,
        });
      } catch (e: any) {
        return errorResponse(`Tower cashout error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_get_my_results`,
    "Get your recent game and match results. Use 'since' timestamp to only get new results since last check. " +
    "Returns both individual game results and spectator match competition results. " +
    "Ideal for cron-based agents that queue, disconnect, and check results later.",
    {
      since: z.number().optional().describe("Unix timestamp (ms) - only return results after this time. The response includes serverTime to use as your next 'since'."),
      game: z.string().optional().describe("Filter by game type: crash, dice, flip, rps"),
      limit: z.number().min(1).max(50).optional().describe("Max results to return (default: 20)"),
    },
    async ({ since, game, limit }) => {
      const err = requireConnected(ws);
      if (err) return err;
      try {
        const params = new URLSearchParams();
        if (since) params.set("since", String(since));
        if (game) params.set("game", game);
        if (limit) params.set("limit", String(limit));

        const data = await authFetch(`/agents/results?${params.toString()}`, { ws });
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(`Results error: ${e.message}`);
      }
    }
  );

  // ── RPS Challenges ──

  server.tool(
    `${P}_get_pending_challenges`,
    "Get incoming RPS challenges waiting for your response. " +
    "Returns challenge details including challenger, wager amount, and time remaining. " +
    "Use accept_challenge to respond with your choice, or decline_challenge to dismiss.",
    {},
    async () => {
      const err = requireConnected(ws);
      if (err) return err;
      const now = Date.now();
      const challenges: any[] = [];
      for (const [id, ch] of ws.pendingChallenges) {
        if (ch.expiresAt < now) {
          ws.pendingChallenges.delete(id);
          continue;
        }
        challenges.push({
          challengeId: ch.challengeId,
          roomId: ch.roomId,
          challengerId: ch.challengerId,
          challengerName: ch.challengerName,
          targetId: ch.targetId,
          isForMe: ch.targetId === ws.accountId,
          wagerAmount: ch.wagerAmount || 0,
          currency: ch.currency || "free",
          secondsRemaining: Math.max(0, Math.round((ch.expiresAt - now) / 1000)),
        });
      }
      return jsonResponse({
        challenges,
        count: challenges.length,
        hint: challenges.length > 0
          ? "Use accept_challenge with the challengeId and your choice (rock/paper/scissors) to respond."
          : "No pending challenges. Challenges appear when another player challenges you to RPS in a room.",
      });
    }
  );

  server.tool(
    `${P}_accept_challenge`,
    "Accept an RPS challenge by submitting your choice (rock, paper, or scissors). " +
    "Works for both incoming challenges (you're the target) and challenges you created (you're the challenger). " +
    "Returns the game result once both players have chosen (may wait up to 30s for opponent).",
    {
      challengeId: z.string().describe("The challenge ID from get_pending_challenges"),
      choice: z.enum(["rock", "paper", "scissors"]).describe("Your choice: rock, paper, or scissors"),
    },
    async ({ challengeId, choice }) => {
      const err = requireConnected(ws);
      if (err) return err;

      const challenge = ws.pendingChallenges.get(challengeId);
      if (!challenge) {
        return errorResponse("Challenge not found. It may have expired or been resolved. Use get_pending_challenges to see active challenges.");
      }

      const roomId = challenge.roomId;

      try {
        // Auto-join the challenge room if needed
        if (ws.currentRoom !== roomId) {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = roomId;
        }

        // Start waiting for result BEFORE sending action (avoid race)
        const resultPromise = ws.waitFor(ServerOp.GameResult, 35_000);
        ws.send(ClientOp.GameAction, { roomId, action: "rps_choice", choice, challengeId });

        const data = await resultPromise;
        ws.pendingChallenges.delete(challengeId);

        if (data.gameType === "rps_timeout") {
          return jsonResponse({
            status: "timeout",
            message: "Challenge timed out - opponent didn't respond.",
          });
        }

        const isWinner = data.winnerId === ws.accountId;
        const isDraw = data.winnerId === null;
        return jsonResponse({
          status: isDraw ? "draw" : isWinner ? "won" : "lost",
          myChoice: choice,
          opponentChoice: data.challengerId === ws.accountId ? data.opponentChoice : data.challengerChoice,
          wagerAmount: data.wagerAmount || 0,
          payout: isWinner ? (data.winnerPayout || 0) : 0,
          currency: data.currency || "free",
        });
      } catch (e: any) {
        ws.pendingChallenges.delete(challengeId);
        return errorResponse(`Challenge error: ${e.message}`);
      }
    }
  );

  server.tool(
    `${P}_decline_challenge`,
    "Decline/dismiss an RPS challenge. Removes it from your pending list immediately. " +
    "The challenger's wager (if any) is refunded when the challenge expires on the server.",
    {
      challengeId: z.string().describe("The challenge ID from get_pending_challenges"),
    },
    async ({ challengeId }) => {
      const err = requireConnected(ws);
      if (err) return err;
      const existed = ws.pendingChallenges.delete(challengeId);
      return jsonResponse({
        declined: true,
        found: existed,
        message: existed
          ? "Challenge dismissed. The challenger's wager will be refunded when it expires."
          : "Challenge not found (may have already expired).",
      });
    }
  );

  server.tool(
    `${P}_create_challenge`,
    "Challenge another player to RPS. You must be in the same room as the target. " +
    "Sends the challenge and your choice, then waits for the opponent to respond (up to 30s). " +
    "If they don't respond, the challenge times out and any wager is refunded.",
    {
      targetId: z.string().describe("Account ID of the player to challenge"),
      choice: z.enum(["rock", "paper", "scissors"]).describe("Your choice: rock, paper, or scissors"),
      wagerAmount: z.number().min(0).max(0.1).optional().describe("Amount to wager in SOL (0 or omit for free play)"),
      roomId: z.string().optional().describe("Room ID where the target is (uses current room if omitted)"),
    },
    async ({ targetId, choice, wagerAmount, roomId: requestedRoom }) => {
      const err = requireConnected(ws);
      if (err) return err;

      const roomId = requestedRoom || ws.currentRoom;
      if (!roomId) {
        return errorResponse("Not in a room. Join a room first or specify a roomId.");
      }

      try {
        // Auto-join the room if needed
        if (ws.currentRoom !== roomId) {
          if (ws.currentRoom) ws._send(ClientOp.LeaveRoom, { roomId: ws.currentRoom });
          ws.currentRoom = null;
          await ws.sendAndWait(ClientOp.JoinRoom, { roomId }, ServerOp.RoomInfo, 5000);
          ws.currentRoom = roomId;
        }

        // Create the challenge and wait for confirmation
        const challengeData = await ws.sendAndWait(
          ClientOp.GamePlay,
          { roomId, gameType: "rps", targetId, wagerAmount: wagerAmount || 0, currency: "SOL" },
          ServerOp.GameChallenge,
          10_000
        );

        // Submit our choice and wait for opponent + result
        const resultPromise = ws.waitFor(ServerOp.GameResult, 35_000);
        ws.send(ClientOp.GameAction, {
          roomId, action: "rps_choice", choice,
          challengeId: challengeData.challengeId,
        });

        const data = await resultPromise;
        ws.pendingChallenges.delete(challengeData.challengeId);

        if (data.gameType === "rps_timeout") {
          return jsonResponse({
            status: "timeout",
            message: "Opponent didn't respond in time. Wager refunded.",
            wagerAmount: wagerAmount || 0,
          });
        }

        const isWinner = data.winnerId === ws.accountId;
        const isDraw = data.winnerId === null;
        return jsonResponse({
          status: isDraw ? "draw" : isWinner ? "won" : "lost",
          myChoice: choice,
          opponentChoice: data.challengerId === ws.accountId ? data.opponentChoice : data.challengerChoice,
          wagerAmount: data.wagerAmount || 0,
          payout: isWinner ? (data.winnerPayout || 0) : 0,
          currency: data.currency || "free",
        });
      } catch (e: any) {
        return errorResponse(`Challenge error: ${e.message}`);
      }
    }
  );
}
