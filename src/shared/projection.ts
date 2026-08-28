import type { Card, CardView, SeatId, TableEvent, TableState, TableView } from "./types";
import { GameError } from "./engine";

const MAX_VIEW_EVENTS = 30;

export interface ProjectionPresence {
  joinedSeatIds?: readonly SeatId[];
  onlineSeatIds?: readonly SeatId[];
}

export function projectTable(state: TableState, seatId: SeatId, presence: ProjectionPresence = {}): TableView {
  const self = state.seats.find((seat) => seat.seatId === seatId);
  const opponent = state.seats.find((seat) => seat.seatId !== seatId);
  if (!self || !opponent) throw new GameError("unknown_seat", "The caller is not seated at this table", 403);

  return {
    roomId: state.roomId,
    revision: state.revision,
    contract: structuredClone(state.contract),
    activeSeatId: state.activeSeatId,
    status: state.status,
    winnerSeatId: state.winnerSeatId,
    self: {
      seatId: self.seatId,
      hand: self.hand.map(cardView),
      zones: state.zones
        .filter((zone) => zone.ownerSeatId === self.seatId && zone.visibility !== "public")
        .map((zone) => ({
          zoneId: zone.id,
          kind: zone.kind,
          visibility: zone.visibility === "hidden" ? "hidden" : "owner",
          ordered: zone.ordered,
          cardCount: zone.cards.length,
          cards: zone.visibility === "hidden" ? [] : zone.cards.map(({ card, face }) => publicCardView(card, face)),
        })),
    },
    opponent: {
      seatId: opponent.seatId,
      presence: !presence.joinedSeatIds?.includes(opponent.seatId)
        ? "waiting"
        : presence.onlineSeatIds?.includes(opponent.seatId) ? "online" : "offline",
      cardCount: opponent.hand.length,
      zones: state.zones
        .filter((zone) => zone.ownerSeatId === opponent.seatId && zone.visibility !== "public")
        .map((zone) => ({ zoneId: zone.id, kind: zone.kind, ordered: zone.ordered, cardCount: zone.cards.length })),
    },
    publicZones: state.zones.filter((zone) => zone.visibility === "public").map((zone) => ({
      zoneId: zone.id,
      ownerSeatId: zone.ownerSeatId,
      kind: zone.kind,
      ordered: zone.ordered,
      cardCount: zone.cards.length,
      cards: zone.cards.map(({ card, face }) => publicCardView(card, face)),
    })),
    recentEvents: state.events.slice(-MAX_VIEW_EVENTS).map(projectEvent),
  };
}

function publicCardView(card: Card, face: "up" | "down") {
  return face === "up"
    ? { id: card.id, face, rank: card.rank, suit: card.suit } as const
    : { id: card.id, face } as const;
}

function cardView(card: Card): CardView {
  return { id: card.id, rank: card.rank, suit: card.suit };
}

function projectEvent(event: TableEvent): TableEvent {
  return structuredClone(event);
}
