import { validateContract } from "./contracts";
import { countCards, createDeck, shuffleCards } from "./deck";
import type {
  ActionEnvelope,
  ActionName,
  Card,
  EngineDependencies,
  GameContract,
  SeatId,
  SeatState,
  TableAction,
  TableEvent,
  TableState,
  Rank,
  ZoneState,
} from "./types";

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 100;
const MAX_ACTION_IDS = 500;

export class GameError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "GameError";
  }
}

export interface CreateTableOptions {
  roomId: string;
  contract: GameContract;
  seatIds: [SeatId, SeatId];
  now: number;
  idFactory: () => string;
  random: EngineDependencies["random"];
}

export function createTable(options: CreateTableOptions): TableState {
  const contract = validateContract(options.contract);
  const deck = shuffleCards(createDeck(options.idFactory), options.random);
  const seats: [SeatState, SeatState] = [
    { seatId: options.seatIds[0], hand: [], books: [] },
    { seatId: options.seatIds[1], hand: [], books: [] },
  ];
  const stockConfig = contract.zones.find((zone) => zone.kind === "stock");
  if (!stockConfig) throw new GameError("missing_stock", "A stock zone is required");

  for (let cardIndex = 0; cardIndex < contract.startingHandSize; cardIndex += 1) {
    for (const seat of seats) {
      const card = deck.pop();
      if (card) seat.hand.push(card);
    }
  }

  const zones: ZoneState[] = contract.zones.map((zone) => ({
    ...zone,
    cards:
      zone.id === stockConfig.id
        ? deck.map((card) => ({ card, face: zone.facing }))
        : [],
  }));

  const state: TableState = {
    schemaVersion: 1,
    roomId: options.roomId,
    revision: 0,
    contract,
    seats,
    activeSeatId: contract.turnOrder === "alternating" ? seats[0].seatId : null,
    zones,
    events: [
      {
        id: options.idFactory(),
        revision: 0,
        type: "room_created",
        actorSeatId: null,
        at: options.now,
        data: { game: contract.name },
      },
    ],
    processedActionIds: [],
    status: "active",
    winnerSeatId: null,
    lastActivityAt: options.now,
    expiresAt: options.now + ROOM_TTL_MS,
    nextBotActionAt: null,
  };
  if (state.contract.kind === "go_fish") {
    const initialEvents: TableEvent[] = [];
    for (const seat of state.seats) layDownBooks(state, seat, 0, options.now, options.idFactory, initialEvents);
    state.events.push(...initialEvents);
    finishGoFishIfComplete(state, 0, options.now, options.idFactory, state.events);
  }
  assertCardConservation(state);
  return state;
}

export function applyAction(
  current: TableState,
  actorSeatId: SeatId,
  envelope: ActionEnvelope,
  dependencies: EngineDependencies,
): TableState {
  if (current.status !== "active") throw new GameError("room_inactive", "This room is no longer active", 409);
  if (current.processedActionIds.includes(envelope.actionId)) {
    throw new GameError("duplicate_action", "This action has already been applied", 409);
  }
  if (envelope.expectedRevision !== current.revision) {
    throw new GameError("stale_revision", "Refresh the table before trying that action again", 409);
  }
  if (!current.seats.some((seat) => seat.seatId === actorSeatId)) {
    throw new GameError("unknown_seat", "The caller is not seated at this table", 403);
  }

  const actionName = envelope.action.type as ActionName;
  if (!current.contract.allowedActions.includes(actionName)) {
    throw new GameError("action_disabled", `${actionName} is not enabled for this table`, 403);
  }
  if (current.contract.turnOrder === "alternating" && current.activeSeatId !== actorSeatId) {
    throw new GameError("wrong_turn", "Wait for your turn before acting", 409);
  }

  const next = structuredClone(current);
  const nextRevision = current.revision + 1;
  const events =
    envelope.action.type === "request_rank"
      ? applyGoFishAction(next, actorSeatId, envelope.action.rank, nextRevision, dependencies)
      : [applyGenericAction(next, actorSeatId, envelope.action, nextRevision, dependencies)];
  next.revision = nextRevision;
  next.lastActivityAt = dependencies.now;
  next.expiresAt = dependencies.now + ROOM_TTL_MS;
  next.processedActionIds = [...next.processedActionIds, envelope.actionId].slice(-MAX_ACTION_IDS);
  next.events = [...next.events, ...events].slice(-MAX_EVENTS);
  assertCardConservation(next);
  return next;
}

function applyGoFishAction(
  state: TableState,
  actorSeatId: SeatId,
  rank: Rank,
  revision: number,
  dependencies: EngineDependencies,
): TableEvent[] {
  if (state.contract.kind !== "go_fish") throw new GameError("wrong_game", "Rank requests are only available in Go Fish");
  const actor = getSeat(state, actorSeatId);
  const opponent = otherSeat(state, actorSeatId);
  if (!actor.hand.some((card) => card.rank === rank)) {
    throw new GameError("rank_not_held", "You may only request a rank in your hand");
  }
  const events: TableEvent[] = [
    makeEvent(dependencies, revision, "rank_requested", actorSeatId, { rank, targetSeatId: opponent.seatId }),
  ];
  const matches = opponent.hand.filter((card) => card.rank === rank);

  if (matches.length > 0) {
    const matchIds = new Set(matches.map((card) => card.id));
    opponent.hand = opponent.hand.filter((card) => !matchIds.has(card.id));
    actor.hand.push(...matches);
    events.push(
      makeEvent(dependencies, revision, "cards_given", opponent.seatId, {
        targetSeatId: actorSeatId,
        count: matches.length,
        rank,
      }),
    );
    state.activeSeatId = actorSeatId;
  } else {
    const stock = getZone(state, "stock");
    const drawn = stock.cards.pop()?.card;
    if (drawn) actor.hand.push(drawn);
    const matched = drawn?.rank === rank;
    events.push(
      makeEvent(dependencies, revision, "go_fish", actorSeatId, {
        drewCard: Boolean(drawn),
        matched,
        requestedRank: rank,
        ...(matched && drawn ? { revealedCard: `${drawn.rank}:${drawn.suit}`, cardId: drawn.id } : {}),
      }),
    );
    state.activeSeatId = matched ? actorSeatId : opponent.seatId;
  }

  layDownBooks(state, actor, revision, dependencies.now, dependencies.eventId, events);
  layDownBooks(state, opponent, revision, dependencies.now, dependencies.eventId, events);
  finishGoFishIfComplete(state, revision, dependencies.now, dependencies.eventId, events);
  if (state.status === "active") prepareActiveSeat(state, revision, dependencies, events);
  return events;
}

function prepareActiveSeat(
  state: TableState,
  revision: number,
  dependencies: EngineDependencies,
  events: TableEvent[],
): void {
  for (let attempts = 0; attempts < 2 && state.status === "active"; attempts += 1) {
    if (!state.activeSeatId) return;
    const seat = getSeat(state, state.activeSeatId);
    if (seat.hand.length > 0) return;
    const stock = getZone(state, "stock");
    const card = stock.cards.pop()?.card;
    if (card) {
      seat.hand.push(card);
      events.push(makeEvent(dependencies, revision, "card_drawn_for_empty_hand", seat.seatId, { count: 1 }));
      layDownBooks(state, seat, revision, dependencies.now, dependencies.eventId, events);
      finishGoFishIfComplete(state, revision, dependencies.now, dependencies.eventId, events);
      if (seat.hand.length > 0 || state.status !== "active") return;
      continue;
    }
    const next = otherSeat(state, seat.seatId);
    state.activeSeatId = next.seatId;
    events.push(makeEvent(dependencies, revision, "turn_ended", seat.seatId, { nextSeatId: next.seatId, reason: "empty_hand" }));
  }
}

function layDownBooks(
  _state: TableState,
  seat: SeatState,
  revision: number,
  now: number,
  eventId: () => string,
  events: TableEvent[],
): void {
  for (const rank of RANK_ORDER) {
    const cards = seat.hand.filter((card) => card.rank === rank);
    if (cards.length !== 4) continue;
    const ids = new Set(cards.map((card) => card.id));
    seat.hand = seat.hand.filter((card) => !ids.has(card.id));
    seat.books.push(cards);
    events.push({
      id: eventId(),
      revision,
      type: "book_made",
      actorSeatId: seat.seatId,
      at: now,
      data: { seatId: seat.seatId, rank, count: 4 },
    });
  }
}

function finishGoFishIfComplete(
  state: TableState,
  revision: number,
  now: number,
  eventId: () => string,
  events: TableEvent[],
): void {
  if (state.seats[0].books.length + state.seats[1].books.length !== 13) return;
  const winner = state.seats[0].books.length > state.seats[1].books.length ? state.seats[0] : state.seats[1];
  state.status = "finished";
  state.winnerSeatId = winner.seatId;
  state.activeSeatId = null;
  state.nextBotActionAt = null;
  events.push({
    id: eventId(),
    revision,
    type: "game_finished",
    actorSeatId: null,
    at: now,
    data: { winnerSeatId: winner.seatId, books: winner.books.length },
  });
}

function makeEvent(
  dependencies: EngineDependencies,
  revision: number,
  type: TableEvent["type"],
  actorSeatId: SeatId | null,
  data: TableEvent["data"],
): TableEvent {
  return { id: dependencies.eventId(), revision, type, actorSeatId, at: dependencies.now, data };
}

const RANK_ORDER: readonly Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function chooseHouseRank(state: TableState, houseSeatId: SeatId = "house"): Rank {
  const hand = getSeat(state, houseSeatId).hand;
  if (hand.length === 0) throw new GameError("empty_house_hand", "The house has no rank to request", 409);
  const counts = new Map<Rank, number>();
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || RANK_ORDER.indexOf(left[0]) - RANK_ORDER.indexOf(right[0]))[0][0];
}

function applyGenericAction(
  state: TableState,
  actorSeatId: SeatId,
  action: TableAction,
  revision: number,
  dependencies: EngineDependencies,
): TableEvent {
  const actor = getSeat(state, actorSeatId);
  const base = { id: dependencies.eventId(), revision, actorSeatId, at: dependencies.now };

  switch (action.type) {
    case "deal": {
      if (!Number.isInteger(action.countPerSeat) || action.countPerSeat < 1 || action.countPerSeat > 13) {
        throw new GameError("invalid_deal_count", "Deal count must be an integer from 1 through 13");
      }
      const zone = getZone(state, action.zoneId);
      const total = action.countPerSeat * state.seats.length;
      if (zone.cards.length < total) throw new GameError("insufficient_cards", `${zone.id} does not have enough cards for that deal`);
      const actorIndex = state.seats.findIndex((seat) => seat.seatId === actorSeatId);
      for (let round = 0; round < action.countPerSeat; round += 1) {
        for (let offset = 0; offset < state.seats.length; offset += 1) {
          const card = zone.cards.pop()?.card;
          if (!card) throw new GameError("insufficient_cards", `${zone.id} does not have enough cards for that deal`);
          state.seats[(actorIndex + offset) % state.seats.length].hand.push(card);
        }
      }
      return { ...base, type: "cards_dealt", data: { zoneId: zone.id, countPerSeat: action.countPerSeat } };
    }
    case "draw": {
      if (!Number.isInteger(action.count) || action.count < 1 || action.count > 13) {
        throw new GameError("invalid_draw_count", "Draw count must be an integer from 1 through 13");
      }
      const zone = getZone(state, action.zoneId);
      if (zone.cards.length === 0) throw new GameError("empty_zone", `${zone.id} has no cards to draw`);
      const count = Math.min(action.count, zone.cards.length);
      const cards = zone.cards.splice(-count).map(({ card }) => card);
      actor.hand.push(...cards);
      return { ...base, type: "cards_drawn", data: { zoneId: zone.id, count } };
    }
    case "move": {
      const cards = takeOwnedCards(actor, action.cardIds);
      const zone = getZone(state, action.zoneId);
      zone.cards.push(...cards.map((card) => ({ card, face: action.face })));
      return {
        ...base,
        type: "cards_moved",
        data: { zoneId: zone.id, cardIds: cards.map((card) => card.id), face: action.face },
      };
    }
    case "give": {
      if (action.targetSeatId === actorSeatId) throw new GameError("same_seat", "Choose the other seat");
      const target = getSeat(state, action.targetSeatId);
      const cards = takeOwnedCards(actor, action.cardIds);
      target.hand.push(...cards);
      return {
        ...base,
        type: "cards_given",
        data: { targetSeatId: target.seatId, count: cards.length },
      };
    }
    case "reveal": {
      const cards = selectOwnedCards(actor, action.cardIds);
      return {
        ...base,
        type: "cards_revealed",
        data: { cardIds: cards.map((card) => card.id), cards: cards.map((card) => `${card.rank}:${card.suit}`) },
      };
    }
    case "shuffle": {
      const zone = getZone(state, action.zoneId);
      zone.cards = shuffleCards(zone.cards, dependencies.random);
      return { ...base, type: "zone_shuffled", data: { zoneId: zone.id, count: zone.cards.length } };
    }
    case "react":
      return { ...base, type: "reaction", data: { reaction: action.reaction } };
    case "end_turn": {
      if (state.contract.turnOrder === "alternating") {
        state.activeSeatId = otherSeat(state, actorSeatId).seatId;
      }
      return {
        ...base,
        type: "turn_ended",
        data: { nextSeatId: state.activeSeatId },
      };
    }
    case "request_rank":
      throw new GameError("wrong_adapter", "Go Fish rank requests use the Go Fish adapter");
  }
}

function takeOwnedCards(seat: SeatState, cardIds: string[]): Card[] {
  const selected = selectOwnedCards(seat, cardIds);
  const selectedIds = new Set(cardIds);
  seat.hand = seat.hand.filter((card) => !selectedIds.has(card.id));
  return selected;
}

function selectOwnedCards(seat: SeatState, cardIds: string[]): Card[] {
  if (cardIds.length < 1 || cardIds.length > 13 || new Set(cardIds).size !== cardIds.length) {
    throw new GameError("invalid_card_ids", "Choose 1 to 13 distinct cards");
  }
  const byId = new Map(seat.hand.map((card) => [card.id, card]));
  const selected = cardIds.map((id) => byId.get(id));
  if (selected.some((card) => card === undefined)) {
    throw new GameError("card_not_owned", "You can only act on cards in your own hand", 403);
  }
  return selected as Card[];
}

export function getSeat(state: TableState, seatId: SeatId): SeatState {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  if (!seat) throw new GameError("unknown_seat", "Seat does not exist", 404);
  return seat;
}

export function otherSeat(state: TableState, seatId: SeatId): SeatState {
  const seat = state.seats.find((candidate) => candidate.seatId !== seatId);
  if (!seat) throw new GameError("missing_opponent", "The other seat does not exist", 500);
  return seat;
}

export function getZone(state: TableState, zoneId: string): ZoneState {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new GameError("unknown_zone", `Zone ${zoneId} does not exist`, 404);
  return zone;
}

export function assertCardConservation(state: TableState): void {
  if (countCards(state) !== 52) throw new GameError("card_conservation", "The table must contain exactly 52 cards", 500);
  const ids = [
    ...state.seats.flatMap((seat) => [...seat.hand, ...seat.books.flat()]).map((card) => card.id),
    ...state.zones.flatMap((zone) => zone.cards.map(({ card }) => card.id)),
  ];
  if (new Set(ids).size !== 52) throw new GameError("duplicate_card", "Every card ID must be unique", 500);
}
