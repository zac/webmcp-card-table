import {
  REACTIONS,
  validateContract,
  type ActionEnvelope,
  type GameContract,
  type Reaction,
  type SeatId,
  type TableAction,
} from "../shared";

const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_BODY_BYTES = 32 * 1024;

export class RequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "RequestError";
  }
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new RequestError("invalid_content_type", "Send an application/json request body", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) throw new RequestError("body_too_large", "Request body is too large", 413);
  if (!request.body) throw new RequestError("missing_body", "A JSON request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError("body_too_large", "Request body is too large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RequestError("invalid_json", "Request body is not valid JSON");
  }
}

export function parseCreateRoom(value: unknown): { contract: GameContract } {
  const object = requireObject(value);
  if (object.mode !== undefined && object.mode !== "free_play") {
    throw new RequestError("invalid_mode", "Only prompt-defined tables are supported");
  }
  return { contract: parseContract(object.contract) };
}

export function parseActionEnvelope(value: unknown): ActionEnvelope {
  const object = requireObject(value);
  if (typeof object.actionId !== "string" || !SAFE_ID.test(object.actionId)) {
    throw new RequestError("invalid_action_id", "actionId must contain 8 to 80 URL-safe characters");
  }
  if (!Number.isInteger(object.expectedRevision) || (object.expectedRevision as number) < 0) {
    throw new RequestError("invalid_revision", "expectedRevision must be a non-negative integer");
  }
  return {
    actionId: object.actionId,
    expectedRevision: object.expectedRevision as number,
    action: parseAction(object.action),
  };
}

export function assertRoomId(value: string): string {
  if (!ROOM_ID.test(value)) throw new RequestError("invalid_room_id", "Room ID is invalid", 404);
  return value;
}

export function assertInviteToken(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new RequestError("invalid_invite", "Invite token is invalid");
  }
  return value;
}

function parseContract(value: unknown): GameContract {
  const object = requireObject(value);
  if (!Array.isArray(object.zones) || !Array.isArray(object.allowedActions)) {
    throw new RequestError("invalid_contract", "Contract zones and allowedActions must be arrays");
  }
  const contract: GameContract = {
    name: requireString(object.name, "name"),
    gamePrompt: requireString(object.gamePrompt, "gamePrompt"),
    startingHandSize: requireNumber(object.startingHandSize, "startingHandSize"),
    startingZoneId: requireString(object.startingZoneId, "startingZoneId"),
    turnOrder:
      object.turnOrder === "alternating" || object.turnOrder === "manual"
        ? object.turnOrder
        : invalid("Contract turnOrder is invalid"),
    zones: object.zones.map((zoneValue) => {
      const zone = requireObject(zoneValue);
      return {
        id: requireString(zone.id, "zone.id"),
        kind:
          zone.kind === "stock" || zone.kind === "discard" || zone.kind === "pile"
            ? zone.kind
            : invalid("Zone kind is invalid"),
        facing: zone.facing === "up" || zone.facing === "down" ? zone.facing : invalid("Zone facing is invalid"),
        scope: zone.scope === "shared" || zone.scope === "seat" ? zone.scope : invalid("Zone scope is invalid"),
        visibility:
          zone.visibility === "public" || zone.visibility === "owner" || zone.visibility === "hidden"
            ? zone.visibility
            : invalid("Zone visibility is invalid"),
        ordered: requireBoolean(zone.ordered, "zone.ordered"),
      };
    }),
    allowedActions: object.allowedActions.map((action) => requireString(action, "allowedActions")) as GameContract["allowedActions"],
  };
  return validateContract(contract);
}

function parseAction(value: unknown): TableAction {
  const action = requireObject(value);
  switch (action.type) {
    case "deal":
      return { type: "deal", zoneId: requireString(action.zoneId, "zoneId"), countPerSeat: requireNumber(action.countPerSeat, "countPerSeat") };
    case "draw":
      return { type: "draw", zoneId: requireString(action.zoneId, "zoneId"), count: requireNumber(action.count, "count") };
    case "move":
      return {
        type: "move",
        cardIds: requireStringArray(action.cardIds, "cardIds"),
        zoneId: requireString(action.zoneId, "zoneId"),
        face: action.face === "up" || action.face === "down" ? action.face : invalid("face must be up or down"),
      };
    case "play_next":
      return {
        type: "play_next",
        sourceZoneId: requireString(action.sourceZoneId, "sourceZoneId"),
        targetZoneId: requireString(action.targetZoneId, "targetZoneId"),
        face: action.face === "up" || action.face === "down" ? action.face : invalid("face must be up or down"),
      };
    case "collect":
      return {
        type: "collect",
        sourceZoneId: requireString(action.sourceZoneId, "sourceZoneId"),
        targetZoneId: requireString(action.targetZoneId, "targetZoneId"),
        placement: action.placement === "top" || action.placement === "bottom" ? action.placement : invalid("placement must be top or bottom"),
      };
    case "give":
      return { type: "give", cardIds: requireStringArray(action.cardIds, "cardIds"), targetSeatId: parseSeatId(action.targetSeatId) };
    case "reveal":
      return { type: "reveal", cardIds: requireStringArray(action.cardIds, "cardIds") };
    case "shuffle":
      return { type: "shuffle", zoneId: requireString(action.zoneId, "zoneId") };
    case "announce":
      return { type: "announce", message: requireString(action.message, "message") };
    case "react": {
      const reaction = requireString(action.reaction, "reaction") as Reaction;
      if (!(REACTIONS as readonly string[]).includes(reaction)) throw new RequestError("invalid_reaction", "Reaction is invalid");
      return { type: "react", reaction };
    }
    case "end_turn":
      return { type: "end_turn" };
    default:
      throw new RequestError("invalid_action", "Action type is invalid");
  }
}

function parseSeatId(value: unknown): SeatId {
  if (value === "host" || value === "guest") return value;
  throw new RequestError("invalid_seat", "Seat ID is invalid");
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("invalid_request", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new RequestError("invalid_request", `${field} must be a string`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") throw new RequestError("invalid_request", `${field} must be a number`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RequestError("invalid_request", `${field} must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestError("invalid_request", `${field} must be an array of strings`);
  }
  return value;
}

function invalid(message: string): never {
  throw new RequestError("invalid_request", message);
}
