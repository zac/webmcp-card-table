import type { Card, CardView, SeatId, TableEvent, TableState, TableView } from "./types";
import { GameError } from "./engine";

const MAX_VIEW_EVENTS = 30;

export function projectTable(state: TableState, seatId: SeatId): TableView {
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
    self: { seatId: self.seatId, hand: self.hand.map(cardView) },
    opponent: {
      seatId: opponent.seatId,
      cardCount: opponent.hand.length,
    },
    publicZones: state.zones.map((zone) => ({
      zoneId: zone.id,
      kind: zone.kind,
      cardCount: zone.cards.length,
      cards: zone.cards.map(({ card, face }) =>
        face === "up"
          ? { id: card.id, face, rank: card.rank, suit: card.suit }
          : { id: card.id, face },
      ),
    })),
    recentEvents: state.events.slice(-MAX_VIEW_EVENTS).map(projectEvent),
  };
}

function cardView(card: Card): CardView {
  return { id: card.id, rank: card.rank, suit: card.suit };
}

function projectEvent(event: TableEvent): TableEvent {
  return structuredClone(event);
}
