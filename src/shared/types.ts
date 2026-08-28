export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export const REACTIONS = ["well_played", "thinking", "ouch", "gg"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Reaction = (typeof REACTIONS)[number];
export type GameKind = "go_fish" | "free_play";
export type SeatId = "host" | "guest" | "human" | "house";

export type GenericActionName =
  | "deal"
  | "draw"
  | "move"
  | "give"
  | "reveal"
  | "shuffle"
  | "react"
  | "end_turn";
export type GoFishActionName = "request_rank";
export type ActionName = GenericActionName | GoFishActionName;

export interface ZoneConfig {
  id: string;
  kind: "stock" | "discard" | "pile";
  facing: "up" | "down";
}

export interface GameContract {
  kind: GameKind;
  name: string;
  objective: string;
  startingHandSize: number;
  turnOrder: "alternating" | "manual";
  zones: ZoneConfig[];
  allowedActions: ActionName[];
  winCondition: string;
  note?: string;
}

export interface Card {
  id: string;
  rank: Rank;
  suit: Suit;
}

export interface ZoneCard {
  card: Card;
  face: "up" | "down";
}

export interface ZoneState extends ZoneConfig {
  cards: ZoneCard[];
}

export interface SeatState {
  seatId: SeatId;
  hand: Card[];
  books: Card[][];
}

export type TableAction =
  | { type: "deal"; zoneId: string; countPerSeat: number }
  | { type: "draw"; zoneId: string; count: number }
  | { type: "move"; cardIds: string[]; zoneId: string; face: "up" | "down" }
  | { type: "give"; cardIds: string[]; targetSeatId: SeatId }
  | { type: "reveal"; cardIds: string[] }
  | { type: "shuffle"; zoneId: string }
  | { type: "react"; reaction: Reaction }
  | { type: "end_turn" }
  | { type: "request_rank"; rank: Rank };

export type TableEventType =
  | "room_created"
  | "cards_dealt"
  | "cards_drawn"
  | "cards_moved"
  | "cards_given"
  | "cards_revealed"
  | "zone_shuffled"
  | "reaction"
  | "turn_ended"
  | "rank_requested"
  | "go_fish"
  | "book_made"
  | "card_drawn_for_empty_hand"
  | "game_finished";

export interface TableEvent {
  id: string;
  revision: number;
  type: TableEventType;
  actorSeatId: SeatId | null;
  at: number;
  data: Record<string, string | number | boolean | string[] | null>;
}

export interface TableState {
  schemaVersion: 1;
  roomId: string;
  revision: number;
  contract: GameContract;
  seats: [SeatState, SeatState];
  activeSeatId: SeatId | null;
  zones: ZoneState[];
  events: TableEvent[];
  processedActionIds: string[];
  status: "active" | "finished" | "expired";
  winnerSeatId: SeatId | null;
  lastActivityAt: number;
  expiresAt: number;
  nextBotActionAt: number | null;
}

export interface ActionEnvelope {
  actionId: string;
  expectedRevision: number;
  action: TableAction;
}

export type PublicCardView =
  | { id: string; face: "down" }
  | { id: string; face: "up"; rank: Rank; suit: Suit };

export interface CardView {
  id: string;
  rank: Rank;
  suit: Suit;
}

export interface PublicZoneView {
  zoneId: string;
  kind: ZoneConfig["kind"];
  cardCount: number;
  cards: PublicCardView[];
}

export interface TableView {
  roomId: string;
  revision: number;
  contract: GameContract;
  activeSeatId: SeatId | null;
  status: TableState["status"];
  winnerSeatId: SeatId | null;
  self: { seatId: SeatId; hand: CardView[]; books?: CardView[][] };
  opponent: { seatId: SeatId; cardCount: number; bookCount?: number };
  publicZones: PublicZoneView[];
  recentEvents: TableEvent[];
}

export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

export interface EngineDependencies {
  now: number;
  random: RandomSource;
  eventId: () => string;
}
