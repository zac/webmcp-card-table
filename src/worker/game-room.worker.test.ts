import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, GAME_PRESETS, type GameContract, type TableState } from "../shared";
import { GameRoom } from "./game-room";

function createInput(roomId: string, contract: GameContract = DEFAULT_FREE_PLAY_CONTRACT) {
  return {
    roomId,
    contract,
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
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM revision_snapshots").one().count).toBe(1);
    });
  });

  it("redeems an invite exactly once", async () => {
    const stub = env.GAME_ROOM.getByName("invite-room");
    await stub.createRoom(createInput("invite-room"));
    const redeemed = await stub.redeemInvite("aW52aXRl", "Z3Vlc3Q", Date.now());
    expect(redeemed.ok && redeemed.value).toMatchObject({ revision: 1, self: { seatId: "guest" }, opponent: { presence: "offline" } });
    const host = await stub.getView("aG9zdA", "host");
    expect(host.ok && host.value).toMatchObject({ revision: 1, opponent: { presence: "offline" }, recentEvents: [{ type: "room_created" }, { type: "seat_joined" }] });
    const repeated = await stub.redeemInvite("aW52aXRl", "YW5vdGhlcg", Date.now());
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe("invite_used");
  });

  it("removes the retired pass action from persisted shipped War contracts", async () => {
    const stub = env.GAME_ROOM.getByName("legacy-war-room");
    const currentWar = GAME_PRESETS.find((preset) => preset.id === "war")!.contract;
    const legacyWar = { ...currentWar, allowedActions: [...currentWar.allowedActions, "end_turn" as const] };
    await stub.createRoom(createInput("legacy-war-room", legacyWar));
    const reloaded = await stub.getView("aG9zdA", "host");
    expect(reloaded.ok && reloaded.value.contract.allowedActions).not.toContain("end_turn");
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

  it("keeps a seat-projected replay after the host freezes the game", async () => {
    const stub = env.GAME_ROOM.getByName("finished-room");
    await stub.createRoom(createInput("finished-room"));
    await stub.redeemInvite("aW52aXRl", "Z3Vlc3Q", Date.now());
    const played = await stub.performAction(
      "aG9zdA",
      "host",
      { actionId: "opening-reaction", expectedRevision: 1, action: { type: "react", reaction: "thinking" } },
      Date.now(),
    );
    expect(played.ok && played.value.revision).toBe(2);

    const guestAttempt = await stub.performAction(
      "Z3Vlc3Q",
      "guest",
      { actionId: "guest-finish", expectedRevision: 2, action: { type: "finish_game" } },
      Date.now(),
    );
    expect(guestAttempt.ok).toBe(false);
    if (!guestAttempt.ok) expect(guestAttempt.error.code).toBe("host_only");

    const finished = await stub.performAction(
      "aG9zdA",
      "host",
      { actionId: "host-finish", expectedRevision: 2, action: { type: "finish_game" } },
      Date.now(),
    );
    expect(finished.ok && finished.value).toMatchObject({ revision: 3, status: "finished", activeSeatId: null });

    const hostOpening = await stub.getReplay("aG9zdA", "host", 0);
    expect(hostOpening.ok && hostOpening.value).toMatchObject({ currentRevision: 3, revisions: [0, 1, 2, 3], view: { revision: 0, status: "active", self: { seatId: "host" } } });
    const guestOpening = await stub.getReplay("Z3Vlc3Q", "guest", 0);
    expect(guestOpening.ok && guestOpening.value).toMatchObject({ view: { revision: 0, self: { seatId: "guest" } } });
    if (hostOpening.ok && guestOpening.ok) {
      expect(hostOpening.value.view.self.hand[0]?.id).not.toBe(guestOpening.value.view.self.hand[0]?.id);
    }
    const finalReplay = await stub.getReplay("aG9zdA", "host", null);
    expect(finalReplay.ok && finalReplay.value.view).toMatchObject({ revision: 3, status: "finished" });

    const afterFinish = await stub.performAction(
      "aG9zdA",
      "host",
      { actionId: "too-late", expectedRevision: 3, action: { type: "react", reaction: "well_played" } },
      Date.now(),
    );
    expect(afterFinish.ok).toBe(false);
    if (!afterFinish.ok) expect(afterFinish.error.code).toBe("room_inactive");

    await runInDurableObject(stub, async (_instance: GameRoom, state) => {
      const row = state.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").one();
      const persisted = JSON.parse(row.state_json) as TableState;
      expect(await state.storage.getAlarm()).toBe(persisted.expiresAt);
    });
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

  it("broadcasts guest redemption and live presence without waiting for a card play", async () => {
    const stub = env.GAME_ROOM.getByName("presence-room");
    const created = await stub.createRoom(createInput("presence-room"));
    expect(created.ok && created.value.opponent.presence).toBe("waiting");

    const hostResponse = await stub.fetch(new Request("https://room.internal/socket", {
      headers: { upgrade: "websocket", "x-session-hash": "aG9zdA", "x-seat-id": "host" },
    }));
    const hostSocket = hostResponse.webSocket;
    expect(hostSocket).not.toBeNull();
    if (!hostSocket) return;
    hostSocket.accept();
    const hostSnapshot = nextSocketMessage(hostSocket);
    hostSocket.send(JSON.stringify({ type: "hello", lastRevision: 99 }));
    expect(await hostSnapshot).toMatchObject({ type: "snapshot", view: { revision: 0, opponent: { presence: "waiting" } } });

    const joinedUpdate = nextSocketMessage(hostSocket);
    const redeemed = await stub.redeemInvite("aW52aXRl", "Z3Vlc3Q", Date.now());
    expect(redeemed.ok && redeemed.value).toMatchObject({ revision: 1, opponent: { presence: "online" } });
    expect(await joinedUpdate).toMatchObject({ type: "update", revision: 1, view: { opponent: { presence: "offline" } }, events: [{ type: "seat_joined" }] });

    const guestOnline = nextSocketMessage(hostSocket);
    const guestResponse = await stub.fetch(new Request("https://room.internal/socket", {
      headers: { upgrade: "websocket", "x-session-hash": "Z3Vlc3Q", "x-seat-id": "guest" },
    }));
    const guestSocket = guestResponse.webSocket;
    expect(guestSocket).not.toBeNull();
    expect(await guestOnline).toMatchObject({ type: "presence", opponentPresence: "online" });
    if (!guestSocket) return;
    guestSocket.accept();

    const guestOffline = nextSocketMessage(hostSocket);
    guestSocket.close(1000, "done");
    expect(await guestOffline).toMatchObject({ type: "presence", opponentPresence: "offline" });
    hostSocket.close(1000, "done");
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
  it("creates a prompt-defined room and returns an invite and room-and-seat-scoped secure cookie", async () => {
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

  it("returns authenticated replay revisions and validates the selector", async () => {
    const created = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: DEFAULT_FREE_PLAY_CONTRACT }),
    });
    const room = await created.json<{ roomId: string }>();
    const cookie = cookiePair(created.headers.get("set-cookie"));
    const headers = { cookie, "x-card-table-seat": "host" };
    const replay = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/replay?revision=0`, { headers });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ currentRevision: 0, revisions: [0], view: { revision: 0, self: { seatId: "host" } } });

    const invalid = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/replay?revision=-1`, { headers });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_revision" });
    const missing = await exports.default.fetch(`http://example.com/api/rooms/${room.roomId}/replay?revision=7`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "replay_unavailable" });
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
