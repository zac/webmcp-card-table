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
      this.broadcastUpdate(next, newEvents);
      await this.scheduleNextAlarm(next);
      return { ok: true, value: projectTable(next, seatId) };
    } catch (error) {
      return failure(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "upgrade_required" }, { status: 426 });
    }
    const sessionHash = request.headers.get("x-session-hash");
    if (!sessionHash) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      const seatId = this.authenticate(sessionHash);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ seatId, lastRevision: null } satisfies SocketAttachment);
      this.ctx.acceptWebSocket(server, [seatId]);
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      const result = failure(error);
      return Response.json(result.error, { status: result.error.status });
    }
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string" || message.length > 1_024) {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message) as unknown;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }
    if (!isHelloMessage(value)) {
      socket.send(JSON.stringify({ type: "error", error: "expected_hello" }));
      return;
    }
    const attachment = readAttachment(socket);
    const state = this.requireState();
    attachment.lastRevision = state.revision;
    socket.serializeAttachment(attachment);
    if (value.lastRevision !== state.revision) {
      socket.send(JSON.stringify({ type: "snapshot", view: projectTable(state, attachment.seatId) }));
    } else {
      socket.send(JSON.stringify({ type: "ready", revision: state.revision }));
    }
  }

  async alarm(): Promise<void> {
    const state = this.loadState();
    if (!state) return;
    const now = Date.now();
    if (state.expiresAt <= now) {
      state.status = "expired";
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

  private broadcastUpdate(state: TableState, events: TableEvent[]): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = readAttachment(socket);
        socket.send(JSON.stringify({
          type: "update",
          revision: state.revision,
          events,
          view: projectTable(state, attachment.seatId),
        }));
        attachment.lastRevision = state.revision;
        socket.serializeAttachment(attachment);
      } catch (error) {
        console.error(JSON.stringify({
          level: "warn",
          event: "socket_broadcast_failed",
          error: error instanceof Error ? error.message : "unknown",
        }));
      }
    }
  }

  private async scheduleNextAlarm(state: TableState): Promise<void> {
    if (state.status !== "active") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(state.expiresAt);
  }
}

interface SocketAttachment {
  seatId: SeatId;
  lastRevision: number | null;
}

function readAttachment(socket: WebSocket): SocketAttachment {
  const attachment = socket.deserializeAttachment();
  if (!attachment || typeof attachment !== "object") throw new GameError("invalid_socket", "Socket attachment is missing", 500);
  const value = attachment as Partial<SocketAttachment>;
  if (typeof value.seatId !== "string") throw new GameError("invalid_socket", "Socket seat is missing", 500);
  return { seatId: value.seatId as SeatId, lastRevision: typeof value.lastRevision === "number" ? value.lastRevision : null };
}

function isHelloMessage(value: unknown): value is { type: "hello"; lastRevision: number } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "hello" && Number.isInteger(message.lastRevision) && (message.lastRevision as number) >= 0;
}

function failure(error: unknown): { ok: false; error: RpcError } {
  if (error instanceof GameError) {
    return { ok: false, error: { code: error.code, message: error.message, status: error.status } };
  }
  console.error(JSON.stringify({ level: "error", event: "game_room_failure", error: error instanceof Error ? error.message : "unknown" }));
  return { ok: false, error: { code: "internal_error", message: "The table could not process that request", status: 500 } };
}
