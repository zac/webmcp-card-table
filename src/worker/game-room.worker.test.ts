import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, type TableState } from "../shared";
import { GameRoom } from "./game-room";

function createInput(roomId: string) {
  return {
    roomId,
    contract: DEFAULT_FREE_PLAY_CONTRACT,
    seatIds: ["host", "guest"] as ["host", "guest"],
    hostSessionHash: "aG9zdA",
    inviteHash: "aW52aXRl",
    now: Date.now(),
  };
}

describe("GameRoom", () => {
  it("persists a room and authenticates its host", async () => {
    const stub = env.GAME_ROOM.getByName("persist-room");
    const created = await stub.createRoom(createInput("persist-room"));
    expect(created.ok).toBe(true);
    const view = await stub.getView("aG9zdA");
    expect(view.ok && view.value.self.seatId).toBe("host");

    await runInDurableObject(stub, async (instance: GameRoom, state) => {
      expect(instance).toBeInstanceOf(GameRoom);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshot").one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count).toBe(1);
    });
  });

  it("redeems an invite exactly once", async () => {
    const stub = env.GAME_ROOM.getByName("invite-room");
    await stub.createRoom(createInput("invite-room"));
    const redeemed = await stub.redeemInvite("aW52aXRl", "Z3Vlc3Q", Date.now());
    expect(redeemed.ok && redeemed.value.self.seatId).toBe("guest");
    const repeated = await stub.redeemInvite("aW52aXRl", "YW5vdGhlcg", Date.now());
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe("invite_used");
  });

  it("persists accepted actions and rejects duplicate IDs", async () => {
    const stub = env.GAME_ROOM.getByName("action-room");
    await stub.createRoom(createInput("action-room"));
    const action = {
      actionId: "action-0001",
      expectedRevision: 0,
      action: { type: "end_turn" as const },
    };
    const accepted = await stub.performAction("aG9zdA", "host", action, Date.now());
    expect(accepted.ok && accepted.value.revision).toBe(1);
    const duplicate = await stub.performAction("aG9zdA", "host", { ...action, expectedRevision: 1 }, Date.now());
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate_action");
  });

  it("resynchronizes stale sockets and streams accepted updates", async () => {
    const stub = env.GAME_ROOM.getByName("socket-room");
    await stub.createRoom(createInput("socket-room"));
    const response = await stub.fetch(
      new Request("https://room.internal/socket", {
        headers: { upgrade: "websocket", "x-session-hash": "aG9zdA" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    if (!socket) return;
    socket.accept();
    const snapshotPromise = nextSocketMessage(socket);
    socket.send(JSON.stringify({ type: "hello", lastRevision: 99 }));
    expect(await snapshotPromise).toMatchObject({ type: "snapshot", view: { revision: 0 } });

    const updatePromise = nextSocketMessage(socket);
    await stub.performAction(
      "aG9zdA",
      "host",
      { actionId: "socket-action", expectedRevision: 0, action: { type: "react", reaction: "thinking" } },
      Date.now(),
    );
    expect(await updatePromise).toMatchObject({ type: "update", revision: 1, view: { revision: 1 } });

    await runInDurableObject(stub, async (_instance: GameRoom, state) => {
      const sockets = state.getWebSockets();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].deserializeAttachment()).toEqual({ seatId: "host", lastRevision: 1 });
    });

    await evictDurableObject(stub);
    const resumedUpdate = nextSocketMessage(socket);
    await stub.performAction(
      "aG9zdA",
      "host",
      { actionId: "after-hibernate", expectedRevision: 1, action: { type: "react", reaction: "well_played" } },
      Date.now(),
    );
    expect(await resumedUpdate).toMatchObject({ type: "update", revision: 2, view: { revision: 2 } });
    socket.close(1000, "done");
  });

  it("schedules and expires an inactive room", async () => {
    const stub = env.GAME_ROOM.getByName("expiry-room");
    await stub.createRoom(createInput("expiry-room"));
    await runInDurableObject(stub, async (_instance: GameRoom, objectState) => {
      const row = objectState.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").one();
      const state = JSON.parse(row.state_json) as TableState;
      expect(await objectState.storage.getAlarm()).toBe(state.expiresAt);
      state.expiresAt = Date.now() - 1;
      objectState.storage.sql.exec("UPDATE snapshot SET state_json = ? WHERE id = 1", JSON.stringify(state));
      await objectState.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const view = await stub.getView("aG9zdA");
    expect(view.ok && view.value.status).toBe("expired");
  });
});

describe("room HTTP API", () => {
  it("creates a prompt-defined room and returns an invite and room-scoped secure cookie", async () => {
    const response = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: DEFAULT_FREE_PLAY_CONTRACT }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ roomId: string; inviteUrl: string; view: { self: { seatId: string } } }>();
    expect(body.view.self.seatId).toBe("host");
    expect(body.inviteUrl).toContain(`#invite=`);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`card_table_host_${body.roomId}=`);
    expect(cookie).toContain(`Path=/api/rooms/${body.roomId}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const viewResponse = await exports.default.fetch(`http://example.com/api/rooms/${body.roomId}/view`, {
      headers: { cookie: cookie ?? "", "x-card-table-seat": "host" },
    });
    expect(viewResponse.status).toBe(200);
  });

  it("redeems the fragment invite once through HTTP", async () => {
    const created = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: DEFAULT_FREE_PLAY_CONTRACT }),
    });
    const body = await created.json<{ roomId: string; inviteUrl: string }>();
    const token = new URL(body.inviteUrl).hash.slice("#invite=".length);
    const redeem = () =>
      exports.default.fetch(`http://example.com/api/rooms/${body.roomId}/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: token }),
      });
    expect((await redeem()).status).toBe(200);
    const repeated = await redeem();
    expect(repeated.status).toBe(409);
    expect(await repeated.json<{ error: string }>()).toMatchObject({ error: "invite_used" });
  });

  it("does not accept a seat cookie in another room", async () => {
    const create = () =>
      exports.default.fetch("http://example.com/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract: DEFAULT_FREE_PLAY_CONTRACT }),
      });
    const first = await create();
    const firstCookie = first.headers.get("set-cookie") ?? "";
    const second = await create();
    const secondBody = await second.json<{ roomId: string }>();
    const response = await exports.default.fetch(`http://example.com/api/rooms/${secondBody.roomId}/view`, {
      headers: { cookie: firstCookie },
    });
    expect(response.status).toBe(401);
  });

  it("keeps host and guest sessions usable in one shared cookie jar", async () => {
    const created = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: DEFAULT_FREE_PLAY_CONTRACT }),
    });
    const room = await created.json<{ roomId: string; inviteUrl: string }>();
    const hostCookie = cookiePair(created.headers.get("set-cookie"));
    const inviteToken = new URL(room.inviteUrl).hash.slice("#invite=".length);
    const redeemed = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: hostCookie },
      body: JSON.stringify({ inviteToken }),
    });
    const guestCookie = cookiePair(redeemed.headers.get("set-cookie"));
    const sharedCookies = `${hostCookie}; ${guestCookie}`;

    const hostView = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/view`, {
      headers: { cookie: sharedCookies, "x-card-table-seat": "host" },
    });
    const guestView = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/view`, {
      headers: { cookie: sharedCookies, "x-card-table-seat": "guest" },
    });
    expect((await hostView.json<{ self: { seatId: string } }>()).self.seatId).toBe("host");
    expect((await guestView.json<{ self: { seatId: string } }>()).self.seatId).toBe("guest");

    const ambiguous = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/view`, {
      headers: { cookie: sharedCookies },
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json<{ error: string }>()).toMatchObject({ error: "seat_required" });
  });
});

function cookiePair(setCookie: string | null): string {
  return setCookie?.split(";", 1)[0] ?? "";
}

function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a socket message")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Invalid socket response"));
        }
      },
      { once: true },
    );
  });
}
