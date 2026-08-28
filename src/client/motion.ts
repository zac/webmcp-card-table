import type { SeatId, TableEvent, TableView } from "../shared";

export type TableMotion =
  | { key: string; type: "play"; actorSeatId: SeatId; targetZoneId: string; targetSeatId: SeatId | null; cardId: string; face: "up" | "down" }
  | { key: string; type: "collect"; actorSeatId: SeatId; sourceZoneId: string; sourceSeatId: SeatId | null };

export function motionForEvent(event: TableEvent, view: TableView): TableMotion | null {
  if (!event.actorSeatId) return null;
  if (event.type === "next_card_played") {
    const targetZoneId = stringValue(event.data.targetZoneId);
    const cardId = stringValue(event.data.cardId);
    const face = event.data.face === "up" || event.data.face === "down" ? event.data.face : null;
    if (!targetZoneId || !cardId || !face) return null;
    return {
      key: event.id,
      type: "play",
      actorSeatId: event.actorSeatId,
      targetZoneId,
      targetSeatId: seatValue(event.data.targetSeatId),
      cardId,
      face,
    };
  }
  if (event.type === "cards_moved") {
    const targetZoneId = stringValue(event.data.zoneId);
    const cardIds = Array.isArray(event.data.cardIds) ? event.data.cardIds : [];
    const cardId = cardIds.at(-1);
    const face = event.data.face === "up" || event.data.face === "down" ? event.data.face : null;
    const target = view.publicZones.find((zone) => zone.zoneId === targetZoneId && (zone.ownerSeatId === event.actorSeatId || zone.ownerSeatId === null));
    if (!targetZoneId || typeof cardId !== "string" || !face || !target) return null;
    return { key: event.id, type: "play", actorSeatId: event.actorSeatId, targetZoneId, targetSeatId: target.ownerSeatId, cardId, face };
  }
  if (event.type === "pile_collected") {
    const sourceZoneId = stringValue(event.data.sourceZoneId);
    if (!sourceZoneId) return null;
    return { key: event.id, type: "collect", actorSeatId: event.actorSeatId, sourceZoneId, sourceSeatId: seatValue(event.data.sourceSeatId) };
  }
  return null;
}

function stringValue(value: TableEvent["data"][string]): string | null {
  return typeof value === "string" ? value : null;
}

function seatValue(value: TableEvent["data"][string]): SeatId | null {
  return value === "host" || value === "guest" ? value : null;
}
