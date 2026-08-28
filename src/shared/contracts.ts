import { REACTIONS, type ActionName, type GameContract, type ZoneConfig } from "./types";

const GENERIC_ACTIONS = new Set<ActionName>([
  "deal",
  "draw",
  "move",
  "give",
  "reveal",
  "shuffle",
  "react",
  "end_turn",
  "request_rank",
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
  if (contract.objective.trim().length < 1 || contract.objective.length > 280) {
    throw new ContractError("invalid_objective", "Objective must contain 1 to 280 characters");
  }
  if (!Number.isInteger(contract.startingHandSize) || contract.startingHandSize < 0 || contract.startingHandSize > 13) {
    throw new ContractError("invalid_hand_size", "Starting hand size must be an integer from 0 through 13");
  }
  if (contract.note !== undefined && contract.note.length > 280) {
    throw new ContractError("invalid_note", "Note cannot exceed 280 characters");
  }
  if (contract.winCondition.trim().length < 1 || contract.winCondition.length > 280) {
    throw new ContractError("invalid_win_condition", "Win condition must contain 1 to 280 characters");
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
    if (zone.kind === "stock") stockCount += 1;
  }
  if (stockCount !== 1) {
    throw new ContractError("invalid_stock", "A contract must contain exactly one stock zone");
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
  if (contract.kind === "go_fish" && contract.allowedActions.includes("end_turn")) {
    throw new ContractError("go_fish_pass", "Go Fish does not allow a voluntary pass");
  }
  if (contract.kind === "go_fish" && !contract.allowedActions.includes("request_rank")) {
    throw new ContractError("go_fish_request", "Go Fish must enable request_rank");
  }
  if (contract.kind === "free_play" && contract.allowedActions.includes("request_rank")) {
    throw new ContractError("free_play_request", "request_rank is reserved for Go Fish");
  }

  return structuredClone(contract);
}

function validateZone(zone: ZoneConfig): void {
  if (!IDENTIFIER.test(zone.id)) {
    throw new ContractError("invalid_zone_id", "Zone IDs must be short lowercase identifiers");
  }
}

export const PRACTICE_CONTRACT: GameContract = {
  kind: "go_fish",
  name: "Practice Go Fish",
  objective: "Collect more four-card books than the house player.",
  startingHandSize: 7,
  turnOrder: "alternating",
  zones: [{ id: "stock", kind: "stock", facing: "down" }],
  allowedActions: ["request_rank", "reveal", "react"],
  winCondition: "The player with more books after all thirteen books are made wins.",
  note: "Ask only for a rank you hold. Catches and matching draws let you go again.",
};

export const DEFAULT_FREE_PLAY_CONTRACT: GameContract = {
  kind: "free_play",
  name: "Open table",
  objective: "Play any two-player game that uses a standard deck.",
  startingHandSize: 5,
  turnOrder: "alternating",
  zones: [
    { id: "stock", kind: "stock", facing: "down" },
    { id: "discard", kind: "discard", facing: "up" },
  ],
  allowedActions: ["deal", "draw", "move", "give", "reveal", "shuffle", "react", "end_turn"],
  winCondition: "The players decide when the game is complete.",
};

export const REACTION_VALUES = [...REACTIONS];
