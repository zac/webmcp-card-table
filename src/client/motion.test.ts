import { describe, expect, it } from "vitest";
import type { TableEvent, TableView } from "../shared";
import { motionForEvent } from "./motion";

const view = {
  publicZones: [
    { zoneId: "stock", ownerSeatId: null },
    { zoneId: "battle", ownerSeatId: "host" },
    { zoneId: "battle", ownerSeatId: "guest" },
  ],
} as TableView;

function event(type: TableEvent["type"], data: TableEvent["data"], actorSeatId: TableEvent["actorSeatId"] = "host"): TableEvent {
  return { id: `event-${type}`, revision: 2, type, actorSeatId, at: 1, data };
}

describe("table motion cues", () => {
  it("maps ordered plays into their player-owned destination", () => {
    expect(motionForEvent(event("next_card_played", {
      sourceZoneId: "deck",
      targetZoneId: "battle",
      targetSeatId: "host",
      cardId: "opaque-7",
      face: "up",
    }), view)).toEqual({
      key: "event-next_card_played",
      type: "play",
      actorSeatId: "host",
      targetZoneId: "battle",
      targetSeatId: "host",
      cardId: "opaque-7",
      face: "up",
    });
  });

  it("derives a moved hand card's shared destination", () => {
    expect(motionForEvent(event("cards_moved", { zoneId: "stock", cardIds: ["opaque-8"], face: "down" }), view)).toMatchObject({
      type: "play",
      targetZoneId: "stock",
      targetSeatId: null,
      cardId: "opaque-8",
      face: "down",
    });
  });

  it("keeps the owner and insertion edge of the pile being collected", () => {
    expect(motionForEvent(event("pile_collected", { sourceZoneId: "battle", sourceSeatId: "guest", targetZoneId: "deck", placement: "bottom", count: 2 }), view)).toMatchObject({
      type: "collect",
      actorSeatId: "host",
      sourceZoneId: "battle",
      sourceSeatId: "guest",
      placement: "bottom",
    });
    expect(motionForEvent(event("pile_collected", { sourceZoneId: "battle", sourceSeatId: "host", targetZoneId: "deck", placement: "top", count: 1 }), view)).toMatchObject({ placement: "top" });
  });

  it("ignores non-card and table-authored events", () => {
    expect(motionForEvent(event("reaction", { reaction: "gg" }), view)).toBeNull();
    expect(motionForEvent(event("room_created", {}, null), view)).toBeNull();
  });
});
