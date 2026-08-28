import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, PRACTICE_CONTRACT, type Card, type Rank, type TableState } from "../shared";
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
    const accepted = await stub.performAction("aG9zdA", action, Date.now());
    expect(accepted.ok && accepted.value.revision).toBe(1);
    const duplicate = await stub.performAction("aG9zdA", { ...action, expectedRevision: 1 }, Date.now());
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
      { actionId: "after-hibernate", expectedRevision: 1, action: { type: "react", reaction: "well_played" } },
      Date.now(),
    );
    expect(await resumedUpdate).toMatchObject({ type: "update", revision: 2, view: { revision: 2 } });
    socket.close(1000, "done");
  });

  it("uses the shared alarm for a paced house action before expiry", async () => {
    const stub = env.GAME_ROOM.getByName("bot-room");
    const startedAt = Date.now();
    await stub.createRoom({
      roomId: "bot-room",
      contract: PRACTICE_CONTRACT,
      seatIds: ["human", "house"],
      hostSessionHash: "aG9zdA",
      inviteHash: null,
      now: startedAt,
    });
    let requestedRank: Rank = "A";
    await runInDurableObject(stub, async (_instance: GameRoom, objectState) => {
      const row = objectState.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").one();
      const state = JSON.parse(row.state_json) as TableState;
      const cards = collectCards(state);
      const humanCard = cards[0];
      const houseCard = cards.find((card) => card.rank !== humanCard.rank);
      const drawCard = cards.find((card) => card.rank !== humanCard.rank && card.rank !== houseCard?.rank);
      if (!houseCard || !drawCard) throw new Error("Could not arrange bot test cards");
      requestedRank = humanCard.rank;
      const used = new Set([humanCard.id, houseCard.id, drawCard.id]);
      state.seats = [
        { seatId: "human", hand: [humanCard], books: [] },
        { seatId: "house", hand: [houseCard], books: [] },
      ];
      state.zones = [{
        id: "stock",
        kind: "stock",
        facing: "down",
        cards: [...cards.filter((card) => !used.has(card.id)), drawCard].map((card) => ({ card, face: "down" })),
      }];
      state.activeSeatId = "human";
      state.revision = 0;
      state.processedActionIds = [];
      objectState.storage.sql.exec("UPDATE snapshot SET state_json = ? WHERE id = 1", JSON.stringify(state));
    });

    const humanAction = await stub.performAction(
      "aG9zdA",
      { actionId: "human-request", expectedRevision: 0, action: { type: "request_rank", rank: requestedRank } },
      startedAt,
    );
    expect(humanAction.ok && humanAction.value.activeSeatId).toBe("house");
    await runInDurableObject(stub, async (_instance: GameRoom, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBe(startedAt + 1_000);
      const row = state.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").one();
      const snapshot = JSON.parse(row.state_json) as TableState;
      snapshot.nextBotActionAt = Date.now() - 1;
      state.storage.sql.exec("UPDATE snapshot SET state_json = ? WHERE id = 1", JSON.stringify(snapshot));
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterBot = await stub.getView("aG9zdA");
    expect(afterBot.ok && afterBot.value.revision).toBe(2);
  });

  it("expires an inactive room through the same alarm", async () => {
    const stub = env.GAME_ROOM.getByName("expiry-room");
    await stub.createRoom(createInput("expiry-room"));
    await runInDurableObject(stub, async (_instance: GameRoom, objectState) => {
      const row = objectState.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM snapshot WHERE id = 1").one();
      const state = JSON.parse(row.state_json) as TableState;
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
  it("creates a practice room and returns a room-scoped secure cookie", async () => {
    const response = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "practice" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ roomId: string; view: { self: { seatId: string } } }>();
    expect(body.view.self.seatId).toBe("human");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`Path=/api/rooms/${body.roomId}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const viewResponse = await exports.default.fetch(`http://example.com/api/rooms/${body.roomId}/view`, {
      headers: { cookie: cookie ?? "" },
    });
    expect(viewResponse.status).toBe(200);
  });

  it("redeems the fragment invite once through HTTP", async () => {
    const created = await exports.default.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "free_play", contract: DEFAULT_FREE_PLAY_CONTRACT }),
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
        body: JSON.stringify({ mode: "practice" }),
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
});

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

function collectCards(state: TableState): Card[] {
  return [
    ...state.seats.flatMap((seat) => [...seat.hand, ...seat.books.flat()]),
    ...state.zones.flatMap((zone) => zone.cards.map(({ card }) => card)),
  ];
}
