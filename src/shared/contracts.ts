import { REACTIONS, type ActionName, type GameContract, type ZoneConfig } from "./types";

const GENERIC_ACTIONS = new Set<ActionName>([
  "deal",
  "draw",
  "move",
  "play_next",
  "collect",
  "give",
  "reveal",
  "shuffle",
  "announce",
  "react",
  "end_turn",
]);
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,29}$/;

export class ContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function validateContract(contract: GameContract): GameContract {
  if (contract.name.trim().length < 1 || contract.name.length > 80) {
    throw new ContractError("invalid_name", "Game name must contain 1 to 80 characters");
  }
  if (contract.gamePrompt.trim().length < 1 || contract.gamePrompt.length > 2_000) {
    throw new ContractError("invalid_game_prompt", "Game prompt must contain 1 to 2,000 characters");
  }
  if (!Number.isInteger(contract.startingHandSize) || contract.startingHandSize < 0 || contract.startingHandSize > 26) {
    throw new ContractError("invalid_hand_size", "Starting hand size must be an integer from 0 through 26");
  }
  if (contract.zones.length < 1 || contract.zones.length > 12) {
    throw new ContractError("invalid_zones", "A contract needs 1 to 12 zones");
  }

  const zoneIds = new Set<string>();
  let stockCount = 0;
  for (const zone of contract.zones) {
    validateZone(zone);
    if (zoneIds.has(zone.id)) {
      throw new ContractError("duplicate_zone", `Zone ${zone.id} appears more than once`);
    }
    zoneIds.add(zone.id);
    if (zone.kind === "stock") {
      stockCount += 1;
      if (zone.scope !== "shared") throw new ContractError("invalid_stock", "The stock zone must be shared");
    }
  }
  if (stockCount !== 1) {
    throw new ContractError("invalid_stock", "A contract must contain exactly one stock zone");
  }
  if (contract.startingZoneId !== "hand") {
    const startingZone = contract.zones.find((zone) => zone.id === contract.startingZoneId);
    if (!startingZone || startingZone.scope !== "seat") {
      throw new ContractError("invalid_starting_zone", "The opening deal must target the hand or a seat-owned zone");
    }
  }

  if (contract.allowedActions.length < 1) {
    throw new ContractError("invalid_actions", "At least one action must be enabled");
  }
  for (const action of new Set(contract.allowedActions)) {
    if (!GENERIC_ACTIONS.has(action)) {
      throw new ContractError("invalid_action", `Unknown action ${action}`);
    }
  }
  if (new Set(contract.allowedActions).size !== contract.allowedActions.length) {
    throw new ContractError("duplicate_action", "Allowed actions cannot contain duplicates");
  }
  return structuredClone(contract);
}

function validateZone(zone: ZoneConfig): void {
  if (!IDENTIFIER.test(zone.id)) {
    throw new ContractError("invalid_zone_id", "Zone IDs must be short lowercase identifiers");
  }
  if (zone.scope === "shared" && zone.visibility !== "public") {
    throw new ContractError("invalid_zone_visibility", "Shared zones must use public visibility");
  }
}

export const ALL_ACTIONS: ActionName[] = ["deal", "draw", "move", "play_next", "collect", "give", "reveal", "shuffle", "announce", "react", "end_turn"];

export type GamePresetId = "go_fish" | "crazy_eights" | "war" | "open_table";

export interface GamePreset {
  id: GamePresetId;
  label: string;
  description: string;
  contract: GameContract;
}

export const GAME_PRESETS: GamePreset[] = [
  {
    id: "go_fish",
    label: "Go Fish",
    description: "Ask, transfer matches, draw, and lay down books.",
    contract: {
      name: "Go Fish",
      gamePrompt: "Play two-player Go Fish. On your turn, announce a rank that appears in your hand. If the opponent has that rank, they give every matching card to you and you continue. Otherwise they announce Go Fish; you draw one card from stock and continue only if it matches the requested rank. Move each set of four equal ranks face-up to your book pile. With no cards in hand, draw one if stock remains. The player with the most books when all cards are resolved wins. Use end_turn only when the rules pass play to the other seat.",
      startingHandSize: 7,
      startingZoneId: "hand",
      turnOrder: "manual",
      zones: [
        { id: "stock", kind: "stock", facing: "down", scope: "shared", visibility: "public", ordered: true },
        { id: "host_books", kind: "pile", facing: "up", scope: "shared", visibility: "public", ordered: false },
        { id: "guest_books", kind: "pile", facing: "up", scope: "shared", visibility: "public", ordered: false },
      ],
      allowedActions: ["draw", "move", "give", "reveal", "shuffle", "announce", "react", "end_turn"],
    },
  },
  {
    id: "crazy_eights",
    label: "Crazy Eights",
    description: "Match suit or rank; eights change the active suit.",
    contract: {
      name: "Crazy Eights",
      gamePrompt: "Play two-player Crazy Eights. Move one card face-up to discard when it matches the top discard by rank or suit. An eight is wild: announce the suit it represents. If you cannot play, draw one from stock; play it if legal, otherwise end your turn. The first player with no cards wins. Announce a win when you play your final card.",
      startingHandSize: 7,
      startingZoneId: "hand",
      turnOrder: "alternating",
      zones: [
        { id: "stock", kind: "stock", facing: "down", scope: "shared", visibility: "public", ordered: true },
        { id: "discard", kind: "discard", facing: "up", scope: "shared", visibility: "public", ordered: true },
      ],
      allowedActions: ["draw", "move", "shuffle", "announce", "react", "end_turn"],
    },
  },
  {
    id: "war",
    label: "War",
    description: "A full-deck showdown with face-up battles.",
    contract: {
      name: "War",
      gamePrompt: "Play two-player War. Each player uses play_next_card to move the top card of their hidden deck face-up to their own battle slot. Higher rank wins; aces are high. The winner collects both battle slots to the bottom of their deck. On a tie, each player plays three cards face-down to their own war pile, then one face-up to their battle slot. Repeat until the tie breaks, then collect both battle slots and both war piles. A player who cannot play the required next card loses.",
      startingHandSize: 26,
      startingZoneId: "deck",
      turnOrder: "manual",
      zones: [
        { id: "stock", kind: "stock", facing: "down", scope: "shared", visibility: "public", ordered: true },
        { id: "battle", kind: "pile", facing: "up", scope: "seat", visibility: "public", ordered: true },
        { id: "war", kind: "pile", facing: "down", scope: "seat", visibility: "public", ordered: true },
        { id: "deck", kind: "pile", facing: "down", scope: "seat", visibility: "hidden", ordered: true },
      ],
      allowedActions: ["play_next", "collect", "shuffle", "announce", "react"],
    },
  },
  {
    id: "open_table",
    label: "Open table",
    description: "Start with a blank rules brief and make it yours.",
    contract: {
      name: "Open table",
      gamePrompt: "Agree on a two-player game using a standard 52-card deck. Announce decisions that the other player needs to know, use the table actions to manipulate only your cards, and announce when the game is complete.",
      startingHandSize: 5,
      startingZoneId: "hand",
      turnOrder: "manual",
      zones: [
        { id: "stock", kind: "stock", facing: "down", scope: "shared", visibility: "public", ordered: true },
        { id: "discard", kind: "discard", facing: "up", scope: "shared", visibility: "public", ordered: true },
      ],
      allowedActions: [...ALL_ACTIONS],
    },
  },
];

export const DEFAULT_FREE_PLAY_CONTRACT: GameContract = structuredClone(
  GAME_PRESETS.find((preset) => preset.id === "open_table")!.contract,
);

export const GO_FISH_PRESET_CONTRACT: GameContract = structuredClone(
  GAME_PRESETS.find((preset) => preset.id === "go_fish")!.contract,
);

/* Kept as a named export for the lobby's initial draft. */
export const DEFAULT_TABLE_CONTRACT: GameContract = DEFAULT_FREE_PLAY_CONTRACT;

export const REACTION_VALUES = [...REACTIONS];
