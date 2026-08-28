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
  const event = applyGenericAction(next, actorSeatId, envelope.action, nextRevision, dependencies);
  next.revision = nextRevision;
  next.lastActivityAt = dependencies.now;
  next.expiresAt = dependencies.now + ROOM_TTL_MS;
  next.processedActionIds = [...next.processedActionIds, envelope.actionId].slice(-MAX_ACTION_IDS);
  next.events = [...next.events, event].slice(-MAX_EVENTS);
  assertCardConservation(next);
  return next;
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
