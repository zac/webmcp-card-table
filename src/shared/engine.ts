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
type GameplayAction = Exclude<TableAction, { type: "finish_game" }>;

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
    { seatId: options.seatIds[0], hand: [] },
    { seatId: options.seatIds[1], hand: [] },
  ];
  const stockConfig = contract.zones.find((zone) => zone.kind === "stock");
  if (!stockConfig) throw new GameError("missing_stock", "A stock zone is required");

  const zones: ZoneState[] = [];
  for (const zone of contract.zones) {
    if (zone.scope === "shared") {
      zones.push({ ...zone, ownerSeatId: null, cards: [] });
    } else {
      for (const seat of seats) zones.push({ ...zone, ownerSeatId: seat.seatId, cards: [] });
    }
  }

  for (let cardIndex = 0; cardIndex < contract.startingHandSize; cardIndex += 1) {
    for (const seat of seats) {
      const card = deck.pop();
      if (!card) continue;
      if (contract.startingZoneId === "hand") {
        seat.hand.push(card);
      } else {
        getOwnedZoneFrom(zones, contract.startingZoneId, seat.seatId).cards.push({
          card,
          face: getOwnedZoneFrom(zones, contract.startingZoneId, seat.seatId).facing,
        });
      }
    }
  }

  const stock = getSharedZoneFrom(zones, stockConfig.id);
  stock.cards = deck.map((card) => ({ card, face: stock.facing }));

  const state: TableState = {
    schemaVersion: 2,
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
  };
  assertCardConservation(state);
  return state;
}

export function recordSeatJoined(state: TableState, seatId: SeatId, dependencies: Pick<EngineDependencies, "now" | "eventId">): TableState {
  if (!state.seats.some((seat) => seat.seatId === seatId)) {
    throw new GameError("unknown_seat", "The joining seat does not exist", 404);
  }
  if (state.status !== "active") {
    throw new GameError("room_inactive", "This table is no longer accepting players", 409);
  }
  const next = structuredClone(state);
  next.revision += 1;
  next.lastActivityAt = dependencies.now;
  next.expiresAt = dependencies.now + ROOM_TTL_MS;
  next.events = [...next.events, {
    id: dependencies.eventId(),
    revision: next.revision,
    type: "seat_joined" as const,
    actorSeatId: seatId,
    at: dependencies.now,
    data: { seatId },
  }].slice(-MAX_EVENTS);
  return next;
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

  const next = structuredClone(current);
  const nextRevision = current.revision + 1;
  let event: TableEvent;
  if (envelope.action.type === "finish_game") {
    if (actorSeatId !== current.seats[0].seatId) {
      throw new GameError("host_only", "Only the host can end this game", 403);
    }
    next.status = "finished";
    next.activeSeatId = null;
    event = {
      id: dependencies.eventId(),
      revision: nextRevision,
      actorSeatId,
      at: dependencies.now,
      type: "game_finished",
      data: {},
    };
  } else {
    const actionName = envelope.action.type as ActionName;
    if (!current.contract.allowedActions.includes(actionName)) {
      throw new GameError("action_disabled", `${actionName} is not enabled for this table`, 403);
    }
    if (current.contract.turnOrder === "alternating" && current.activeSeatId !== actorSeatId) {
      throw new GameError("wrong_turn", "Wait for your turn before acting", 409);
    }
    event = applyGenericAction(next, actorSeatId, envelope.action, nextRevision, dependencies);
  }
  const events = [event];
  next.revision = nextRevision;
  next.lastActivityAt = dependencies.now;
  next.expiresAt = dependencies.now + ROOM_TTL_MS;
  next.processedActionIds = [...next.processedActionIds, envelope.actionId].slice(-MAX_ACTION_IDS);
  next.events = [...next.events, ...events].slice(-MAX_EVENTS);
  assertCardConservation(next);
  return next;
}

function applyGenericAction(
  state: TableState,
  actorSeatId: SeatId,
  action: GameplayAction,
  revision: number,
  dependencies: EngineDependencies,
): TableEvent {
  const actor = getSeat(state, actorSeatId);
  const base = { id: dependencies.eventId(), revision, actorSeatId, at: dependencies.now };

  switch (action.type) {
    case "deal": {
      if (!Number.isInteger(action.countPerSeat) || action.countPerSeat < 1 || action.countPerSeat > 26) {
        throw new GameError("invalid_deal_count", "Deal count must be an integer from 1 through 26");
      }
      const zone = getSharedZone(state, action.zoneId);
      const total = action.countPerSeat * state.seats.length;
      if (zone.cards.length < total) throw new GameError("insufficient_cards", `${zone.id} does not have enough cards for that deal`);
      const actorIndex = state.seats.findIndex((seat) => seat.seatId === actorSeatId);
      for (let round = 0; round < action.countPerSeat; round += 1) {
        for (let offset = 0; offset < state.seats.length; offset += 1) {
          const card = zone.cards.pop()?.card;
          if (!card) throw new GameError("insufficient_cards", `${zone.id} does not have enough cards for that deal`);
          const targetSeat = state.seats[(actorIndex + offset) % state.seats.length];
          placeOpeningCard(state, targetSeat, card);
        }
      }
      return { ...base, type: "cards_dealt", data: { zoneId: zone.id, countPerSeat: action.countPerSeat } };
    }
    case "draw": {
      if (!Number.isInteger(action.count) || action.count < 1 || action.count > 13) {
        throw new GameError("invalid_draw_count", "Draw count must be an integer from 1 through 13");
      }
      const zone = getSharedZone(state, action.zoneId);
      if (zone.cards.length === 0) throw new GameError("empty_zone", `${zone.id} has no cards to draw`);
      const count = Math.min(action.count, zone.cards.length);
      const cards = zone.cards.splice(-count).map(({ card }) => card);
      actor.hand.push(...cards);
      return { ...base, type: "cards_drawn", data: { zoneId: zone.id, count } };
    }
    case "move": {
      const cards = takeOwnedCards(actor, action.cardIds);
      const zone = getPublicDestinationZone(state, action.zoneId, actorSeatId);
      zone.cards.push(...cards.map((card) => ({ card, face: action.face })));
      return {
        ...base,
        type: "cards_moved",
        data: { zoneId: zone.id, cardIds: cards.map((card) => card.id), face: action.face },
      };
    }
    case "play_next": {
      const source = getOwnedZone(state, action.sourceZoneId, actorSeatId);
      if (!source.ordered) throw new GameError("unordered_zone", `${source.id} does not have a next card`);
      const nextCard = source.cards.pop();
      if (!nextCard) throw new GameError("empty_zone", `${source.id} has no cards to play`);
      const target = getPublicDestinationZone(state, action.targetZoneId, actorSeatId);
      target.cards.push({ card: nextCard.card, face: action.face });
      return {
        ...base,
        type: "next_card_played",
        data: { sourceZoneId: source.id, targetZoneId: target.id, targetSeatId: target.ownerSeatId, face: action.face, cardId: nextCard.card.id },
      };
    }
    case "collect": {
      const source = getCollectiblePublicZone(state, action.sourceZoneId, action.sourceSeatId, actorSeatId);
      if (source.cards.length === 0) throw new GameError("empty_zone", `${source.id} has no cards to collect`);
      const target = getOwnedZone(state, action.targetZoneId, actorSeatId);
      if (!target.ordered) throw new GameError("unordered_zone", `${target.id} cannot receive an ordered pile`);
      const collected = source.cards.splice(0).map(({ card }) => ({ card, face: target.facing }));
      if (action.placement === "bottom") target.cards.unshift(...collected);
      else target.cards.push(...collected);
      return {
        ...base,
        type: "pile_collected",
        data: { sourceZoneId: source.id, sourceSeatId: source.ownerSeatId, targetZoneId: target.id, placement: action.placement, count: collected.length },
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
      const zone = getAccessibleZone(state, action.zoneId, actorSeatId);
      zone.cards = shuffleCards(zone.cards, dependencies.random);
      return { ...base, type: "zone_shuffled", data: { zoneId: zone.id, count: zone.cards.length } };
    }
    case "announce": {
      const message = action.message.trim();
      if (message.length < 1 || message.length > 160) {
        throw new GameError("invalid_announcement", "Announcements must contain 1 to 160 characters");
      }
      return { ...base, type: "announcement", data: { message } };
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

export function getSharedZone(state: TableState, zoneId: string): ZoneState {
  return getSharedZoneFrom(state.zones, zoneId);
}

export function getOwnedZone(state: TableState, zoneId: string, seatId: SeatId): ZoneState {
  return getOwnedZoneFrom(state.zones, zoneId, seatId);
}

function getAccessibleZone(state: TableState, zoneId: string, seatId: SeatId): ZoneState {
  const zone = state.zones.find((candidate) => candidate.id === zoneId && (candidate.ownerSeatId === null || candidate.ownerSeatId === seatId));
  if (!zone) throw new GameError("unknown_zone", `Zone ${zoneId} does not exist for this seat`, 404);
  return zone;
}

function getPublicDestinationZone(state: TableState, zoneId: string, actorSeatId: SeatId): ZoneState {
  const zone = state.zones.find((candidate) => candidate.id === zoneId && (candidate.ownerSeatId === null || candidate.ownerSeatId === actorSeatId));
  if (!zone || zone.visibility !== "public") throw new GameError("unknown_zone", `Public zone ${zoneId} does not exist for this seat`, 404);
  return zone;
}

function getCollectiblePublicZone(state: TableState, zoneId: string, sourceSeatId: SeatId | undefined, actorSeatId: SeatId): ZoneState {
  const shared = state.zones.find((candidate) => candidate.id === zoneId && candidate.ownerSeatId === null);
  if (shared) return shared;
  const ownerSeatId = sourceSeatId ?? actorSeatId;
  const zone = state.zones.find((candidate) => candidate.id === zoneId && candidate.ownerSeatId === ownerSeatId);
  if (!zone || zone.visibility !== "public") throw new GameError("unknown_zone", `Public zone ${zoneId} does not exist for ${ownerSeatId}`, 404);
  return zone;
}

export function assertCardConservation(state: TableState): void {
  if (countCards(state) !== 52) throw new GameError("card_conservation", "The table must contain exactly 52 cards", 500);
  const ids = [
    ...state.seats.flatMap((seat) => seat.hand).map((card) => card.id),
    ...state.zones.flatMap((zone) => zone.cards.map(({ card }) => card.id)),
  ];
  if (new Set(ids).size !== 52) throw new GameError("duplicate_card", "Every card ID must be unique", 500);
}

function placeOpeningCard(state: TableState, seat: SeatState, card: Card): void {
  if (state.contract.startingZoneId === "hand") {
    seat.hand.push(card);
    return;
  }
  const zone = getOwnedZone(state, state.contract.startingZoneId, seat.seatId);
  zone.cards.push({ card, face: zone.facing });
}

function getSharedZoneFrom(zones: ZoneState[], zoneId: string): ZoneState {
  const zone = zones.find((candidate) => candidate.id === zoneId && candidate.ownerSeatId === null);
  if (!zone) throw new GameError("unknown_zone", `Shared zone ${zoneId} does not exist`, 404);
  return zone;
}

function getOwnedZoneFrom(zones: ZoneState[], zoneId: string, seatId: SeatId): ZoneState {
  const zone = zones.find((candidate) => candidate.id === zoneId && candidate.ownerSeatId === seatId);
  if (!zone) throw new GameError("unknown_zone", `Seat zone ${zoneId} does not exist`, 404);
  return zone;
}
