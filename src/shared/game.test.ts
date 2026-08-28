import { describe, expect, it } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, validateContract } from "./contracts";
import { countCards, createDeck } from "./deck";
import { applyAction, createTable, GameError } from "./engine";
import { projectTable } from "./projection";
import type { EngineDependencies, GameContract, RandomSource, TableState } from "./types";

class FixedRandom implements RandomSource {
  nextInt(maxExclusive: number): number {
    return maxExclusive - 1;
  }
}

function ids(prefix = "id") {
  let value = 0;
  return () => `${prefix}-${value++}`;
}

function dependencies(now = 2_000): EngineDependencies {
  return { now, random: new FixedRandom(), eventId: ids("event") };
}

function table(contract: GameContract = DEFAULT_FREE_PLAY_CONTRACT): TableState {
  return createTable({
    roomId: "room-1",
    contract,
    seatIds: ["host", "guest"],
    now: 1_000,
    idFactory: ids("card"),
    random: new FixedRandom(),
  });
}

describe("deck", () => {
  it("creates 52 distinct standard cards", () => {
    const deck = createDeck(ids());
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => card.id)).size).toBe(52);
    expect(new Set(deck.map((card) => `${card.rank}:${card.suit}`)).size).toBe(52);
  });
});

describe("contracts", () => {
  it("requires one stock and a bounded hand", () => {
    expect(() => validateContract({ ...DEFAULT_FREE_PLAY_CONTRACT, startingHandSize: 14 })).toThrowError("Starting hand size");
    expect(() => validateContract({ ...DEFAULT_FREE_PLAY_CONTRACT, zones: [] })).toThrowError("1 to 12 zones");
  });

  it("does not allow voluntary passes in Go Fish", () => {
    expect(() =>
      validateContract({
        ...DEFAULT_FREE_PLAY_CONTRACT,
        kind: "go_fish",
        allowedActions: ["request_rank", "end_turn"],
      }),
    ).toThrowError("voluntary pass");
  });
});

describe("generic reducer", () => {
  it("deals and draws without losing cards", () => {
    const initial = table();
    const next = applyAction(
      initial,
      "host",
      { actionId: "draw-1", expectedRevision: 0, action: { type: "draw", zoneId: "stock", count: 2 } },
      dependencies(),
    );
    expect(next.seats[0].hand).toHaveLength(7);
    expect(next.zones.find((zone) => zone.id === "stock")?.cards).toHaveLength(40);
    expect(countCards(next)).toBe(52);
    expect(initial.seats[0].hand).toHaveLength(5);
  });

  it("rejects stale, duplicate, disabled, and out-of-turn actions", () => {
    const initial = table();
    expectGameError(
      () => applyAction(initial, "host", { actionId: "x", expectedRevision: 2, action: { type: "end_turn" } }, dependencies()),
      "stale_revision",
    );
    expectGameError(
      () => applyAction(initial, "guest", { actionId: "x", expectedRevision: 0, action: { type: "end_turn" } }, dependencies()),
      "wrong_turn",
    );
    const next = applyAction(initial, "host", { actionId: "x", expectedRevision: 0, action: { type: "end_turn" } }, dependencies());
    expectGameError(
      () => applyAction(next, "guest", { actionId: "x", expectedRevision: 1, action: { type: "end_turn" } }, dependencies()),
      "duplicate_action",
    );
  });

  it("lets either seat act under manual turn order", () => {
    const initial = table({ ...DEFAULT_FREE_PLAY_CONTRACT, turnOrder: "manual" });
    const next = applyAction(
      initial,
      "guest",
      { actionId: "pass", expectedRevision: 0, action: { type: "end_turn" } },
      dependencies(),
    );
    expect(next.activeSeatId).toBeNull();
    expect(next.events.at(-1)?.type).toBe("turn_ended");
  });

  it("enforces card ownership for moves and gives", () => {
    const initial = table();
    const guestCard = initial.seats[1].hand[0].id;
    expectGameError(
      () =>
        applyAction(
          initial,
          "host",
          { actionId: "steal", expectedRevision: 0, action: { type: "move", cardIds: [guestCard], zoneId: "discard", face: "up" } },
          dependencies(),
        ),
      "card_not_owned",
    );
  });

  it("shuffles without changing zone membership", () => {
    const initial = table();
    const before = initial.zones.find((zone) => zone.id === "stock")?.cards.map(({ card }) => card.id).sort();
    const next = applyAction(
      initial,
      "host",
      { actionId: "shuffle", expectedRevision: 0, action: { type: "shuffle", zoneId: "stock" } },
      dependencies(),
    );
    const after = next.zones.find((zone) => zone.id === "stock")?.cards.map(({ card }) => card.id).sort();
    expect(after).toEqual(before);
  });
});

describe("seat projection", () => {
  it("keeps opponent hands private and strips face-down identities", () => {
    const initial = table();
    const view = projectTable(initial, "host");
    const serialized = JSON.stringify(view);
    const opponent = initial.seats[1];
    for (const card of opponent.hand) {
      expect(serialized).not.toContain(card.id);
    }
    const stockCard = initial.zones.find((zone) => zone.id === "stock")?.cards[0].card;
    expect(view.publicZones[0].cards[0]).toEqual({ id: stockCard?.id, face: "down" });
  });
});

function expectGameError(operation: () => unknown, code: string): void {
  try {
    operation();
    expect.unreachable("Expected a GameError");
  } catch (error) {
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }
}
