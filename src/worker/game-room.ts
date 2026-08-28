import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  createTable,
  GameError,
  projectTable,
  type ActionEnvelope,
  type GameContract,
  type SeatId,
  type TableEvent,
  type TableState,
  type TableView,
} from "../shared";
import { CryptoRandomSource, secureHashEqual } from "./crypto";

interface CreateRoomInput {
  roomId: string;
  contract: GameContract;
  seatIds: [SeatId, SeatId];
  hostSessionHash: string;
  inviteHash: string | null;
  now: number;
}

interface RpcError {
  code: string;
  message: string;
  status: number;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_hash TEXT PRIMARY KEY,
        seat_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token_hash TEXT NOT NULL,
        redeemed_at INTEGER
      );
    `);
  }

  async createRoom(input: CreateRoomInput): Promise<RpcResult<TableView>> {
    try {
      if (this.loadState()) throw new GameError("room_exists", "This room already exists", 409);
      const state = createTable({
        roomId: input.roomId,
        contract: input.contract,
        seatIds: input.seatIds,
        now: input.now,
        idFactory: () => crypto.randomUUID(),
        random: new CryptoRandomSource(),
      });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO sessions (session_hash, seat_id) VALUES (?, ?)", input.hostSessionHash, input.seatIds[0]);
        if (input.inviteHash) {
          this.ctx.storage.sql.exec("INSERT INTO invite (id, token_hash, redeemed_at) VALUES (1, ?, NULL)", input.inviteHash);
        }
        this.persistState(state, state.events);
      });
      await this.scheduleNextAlarm(state);
      return { ok: true, value: projectTable(state, input.seatIds[0]) };
    } catch (error) {
      return failure(error);
    }
  }

  async redeemInvite(inviteHash: string, sessionHash: string, now: number): Promise<RpcResult<TableView>> {
    try {
      const state = this.requireState();
      if (state.contract.kind !== "free_play") throw new GameError("no_invite", "This room does not accept invitations", 404);
      const invite = this.ctx.storage.sql.exec<{ token_hash: string; redeemed_at: number | null }>(
        "SELECT token_hash, redeemed_at FROM invite WHERE id = 1",
      ).one();
      if (invite.redeemed_at !== null) throw new GameError("invite_used", "This invite has already been redeemed", 409);
      if (!secureHashEqual(inviteHash, invite.token_hash)) throw new GameError("invalid_invite", "Invite token is invalid", 403);
      const guestSeat = state.seats[1].seatId;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE invite SET redeemed_at = ? WHERE id = 1", now);
        this.ctx.storage.sql.exec("INSERT INTO sessions (session_hash, seat_id) VALUES (?, ?)", sessionHash, guestSeat);
      });
      return { ok: true, value: projectTable(state, guestSeat) };
    } catch (error) {
      return failure(error);
    }
  }

  async getView(sessionHash: string): Promise<RpcResult<TableView>> {
    try {
      const state = this.requireState();
      const seatId = this.authenticate(sessionHash);
      return { ok: true, value: projectTable(state, seatId) };
    } catch (error) {
      return failure(error);
    }
  }

  async performAction(sessionHash: string, envelope: ActionEnvelope, now: number): Promise<RpcResult<TableView>> {
    try {
      const current = this.requireState();
      const seatId = this.authenticate(sessionHash);
      const next = applyAction(current, seatId, envelope, {
        now,
        random: new CryptoRandomSource(),
        eventId: () => crypto.randomUUID(),
      });
      const priorEventIds = new Set(current.events.map((event) => event.id));
      const newEvents = next.events.filter((event) => !priorEventIds.has(event.id));
      this.ctx.storage.transactionSync(() => this.persistState(next, newEvents));
      await this.scheduleNextAlarm(next);
      return { ok: true, value: projectTable(next, seatId) };
    } catch (error) {
      return failure(error);
    }
  }

  async alarm(): Promise<void> {
    const state = this.loadState();
    if (!state) return;
    const now = Date.now();
    if (state.expiresAt <= now) {
      state.status = "expired";
      state.nextBotActionAt = null;
      this.ctx.storage.transactionSync(() => this.persistState(state, []));
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Room expired");
      return;
    }
    await this.scheduleNextAlarm(state);
  }

  private authenticate(sessionHash: string): SeatId {
    const sessions = this.ctx.storage.sql.exec<{ session_hash: string; seat_id: SeatId }>(
      "SELECT session_hash, seat_id FROM sessions",
    ).toArray();
    const session = sessions.find((candidate) => secureHashEqual(sessionHash, candidate.session_hash));
    if (!session) throw new GameError("unauthorized", "A valid seat session is required", 401);
    return session.seat_id;
  }

  private requireState(): TableState {
    const state = this.loadState();
    if (!state) throw new GameError("room_not_found", "Room does not exist", 404);
    return state;
  }

  private loadState(): TableState | null {
    const rows = this.ctx.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").toArray();
    return rows[0] ? (JSON.parse(rows[0].state_json) as TableState) : null;
  }

  private persistState(state: TableState, events: TableEvent[]): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO snapshot (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
      JSON.stringify(state),
    );
    for (const event of events) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO events (event_id, revision, event_json) VALUES (?, ?, ?)",
        event.id,
        event.revision,
        JSON.stringify(event),
      );
    }
  }

  private async scheduleNextAlarm(state: TableState): Promise<void> {
    const candidates = [state.expiresAt, state.nextBotActionAt].filter((value): value is number => value !== null);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }
}

function failure(error: unknown): { ok: false; error: RpcError } {
  if (error instanceof GameError) {
    return { ok: false, error: { code: error.code, message: error.message, status: error.status } };
  }
  console.error(JSON.stringify({ level: "error", event: "game_room_failure", error: error instanceof Error ? error.message : "unknown" }));
  return { ok: false, error: { code: "internal_error", message: "The table could not process that request", status: 500 } };
}
