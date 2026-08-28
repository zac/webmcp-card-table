import { describe, expect, it } from "vitest";
import { PRACTICE_CONTRACT } from "./contracts";
import { applyAction, chooseHouseRank, createTable, GameError } from "./engine";
import type { Card, EngineDependencies, RandomSource, Rank, Suit, TableEvent, TableState } from "./types";

class FixedRandom implements RandomSource {
  nextInt(maxExclusive: number): number {
    return maxExclusive - 1;
  }
}

function ids(prefix: string) {
  let value = 0;
  return () => `${prefix}-${value++}`;
}

function deps(now = 2_000): EngineDependencies {
  return { now, random: new FixedRandom(), eventId: ids("event") };
}

function practice(): TableState {
  return createTable({
    roomId: "practice",
    contract: PRACTICE_CONTRACT,
    seatIds: ["human", "house"],
    now: 1_000,
    idFactory: ids("card"),
    random: new FixedRandom(),
  });
}

function arrange(
  state: TableState,
  humanCards: string[],
  houseCards: string[],
  stockTop: string[] = [],
): TableState {
  const next = structuredClone(state);
  const allCards = [
    ...next.seats.flatMap((seat) => [...seat.hand, ...seat.books.flat()]),
    ...next.zones.flatMap((zone) => zone.cards.map(({ card }) => card)),
  ];
  const byKey = new Map(allCards.map((card) => [key(card), card]));
  const take = (specs: string[]) => specs.map((spec) => {
    const card = byKey.get(spec);
    if (!card) throw new Error(`Missing test card ${spec}`);
    byKey.delete(spec);
    return card;
  });
  const human = take(humanCards);
  const house = take(houseCards);
  const top = take(stockTop);
  next.seats[0] = { seatId: "human", hand: human, books: [] };
  next.seats[1] = { seatId: "house", hand: house, books: [] };
  next.zones = [{ id: "stock", kind: "stock", facing: "down", cards: [...byKey.values(), ...top].map((card) => ({ card, face: "down" })) }];
  next.activeSeatId = "human";
  next.status = "active";
  next.winnerSeatId = null;
  next.revision = 0;
  next.processedActionIds = [];
  return next;
}

function request(state: TableState, rank: Rank, now = 2_000): TableState {
  return applyAction(
    state,
    state.activeSeatId ?? "human",
    { actionId: `request-${rank}-${now}`, expectedRevision: state.revision, action: { type: "request_rank", rank } },
    deps(now),
  );
}

describe("Go Fish", () => {
  it("transfers every matching card, makes a book, and lets the asker continue", () => {
    const state = arrange(practice(), ["A:clubs"], ["A:diamonds", "A:hearts", "A:spades"]);
    const next = request(state, "A");
    expect(next.seats[0].books).toHaveLength(1);
    expect(next.seats[0].books[0].map((card) => card.rank)).toEqual(["A", "A", "A", "A"]);
    expect(next.activeSeatId).toBe("human");
    expect(next.seats[0].hand).toHaveLength(1);
    expect(next.events.map((event) => event.type)).toEqual(expect.arrayContaining(["rank_requested", "cards_given", "book_made"]));
  });

  it("reveals a matching draw and lets the asker continue", () => {
    const state = arrange(practice(), ["A:clubs"], ["2:clubs"], ["A:diamonds"]);
    const next = request(state, "A");
    expect(next.activeSeatId).toBe("human");
    const event = latestEvent(next.events, "go_fish");
    expect(event?.data).toMatchObject({ matched: true, revealedCard: "A:diamonds" });
  });

  it("passes after a nonmatching draw", () => {
    const state = arrange(practice(), ["A:clubs"], ["2:clubs"], ["K:clubs"]);
    const next = request(state, "A");
    expect(next.activeSeatId).toBe("house");
    expect(latestEvent(next.events, "go_fish")?.data).toMatchObject({ matched: false });
  });

  it("draws for the next seat when that seat starts empty", () => {
    const state = arrange(practice(), ["A:clubs"], [], ["Q:clubs", "K:clubs"]);
    const next = request(state, "A");
    expect(next.activeSeatId).toBe("house");
    expect(next.seats[1].hand.map(key)).toEqual(["Q:clubs"]);
    expect(next.events.some((event) => event.type === "card_drawn_for_empty_hand")).toBe(true);
  });

  it("passes a miss cleanly when the stock is empty", () => {
    const state = arrange(practice(), ["A:clubs"], ["2:clubs"]);
    const stock = state.zones[0];
    state.zones.push({ id: "holding", kind: "pile", facing: "down", cards: stock.cards.splice(0) });
    const next = request(state, "A");
    expect(next.activeSeatId).toBe("house");
    expect(latestEvent(next.events, "go_fish")?.data).toMatchObject({ drewCard: false, matched: false });
  });

  it("rejects a rank the asker does not hold", () => {
    const state = arrange(practice(), ["A:clubs"], ["2:clubs"]);
    expect(() => request(state, "K")).toThrowError(GameError);
    try {
      request(state, "K");
    } catch (error) {
      expect((error as GameError).code).toBe("rank_not_held");
    }
  });

  it("finishes after the thirteenth book and selects the higher score", () => {
    const state = practice();
    const allCards = [
      ...state.seats.flatMap((seat) => seat.hand),
      ...state.zones.flatMap((zone) => zone.cards.map(({ card }) => card)),
    ];
    const byRank = new Map<Rank, Card[]>();
    for (const card of allCards) byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), card]);
    const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q"];
    const humanBooks = ranks.slice(0, 7).map((rank) => byRank.get(rank) ?? []);
    const houseBooks = ranks.slice(7).map((rank) => byRank.get(rank) ?? []);
    const kings = byRank.get("K") ?? [];
    state.seats = [
      { seatId: "human", hand: [kings[0]], books: humanBooks },
      { seatId: "house", hand: kings.slice(1), books: houseBooks },
    ];
    state.zones[0].cards = [];
    state.activeSeatId = "human";
    const next = request(state, "K");
    expect(next.status).toBe("finished");
    expect(next.winnerSeatId).toBe("human");
    expect(next.seats[0].books).toHaveLength(8);
    expect(next.events.at(-1)?.type).toBe("game_finished");
  });
});

describe("house strategy", () => {
  it("chooses the most frequent rank and breaks ties with aces low", () => {
    const state = arrange(practice(), ["K:spades"], ["A:clubs", "2:clubs", "2:diamonds"]);
    expect(chooseHouseRank(state)).toBe("2");
    state.seats[1].hand = state.seats[1].hand.slice(0, 2);
    expect(chooseHouseRank(state)).toBe("A");
  });
});

function key(card: { rank: Rank; suit: Suit }): string {
  return `${card.rank}:${card.suit}`;
}

function latestEvent(events: TableEvent[], type: TableEvent["type"]): TableEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}
