import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT } from "../shared";
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
