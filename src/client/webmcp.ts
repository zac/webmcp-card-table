import {
  DEFAULT_FREE_PLAY_CONTRACT,
  GAME_PRESETS,
  REACTIONS,
  validateContract,
  type ActionName,
  type GameContract,
  type GamePresetId,
  type Reaction,
  type TableAction,
  type TableEvent,
  type TableView,
} from "../shared";

type JsonSchema = Record<string, unknown>;

export interface WebMcpTool<T = Record<string, unknown>> {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: T, context?: { signal?: AbortSignal }) => Promise<string> | string;
}

export interface WebMcpContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

declare global {
  interface Document {
    modelContext?: WebMcpContext;
  }
}

export interface DraftTableInput {
  preset?: GamePresetId;
  name?: string;
  gamePrompt?: string;
  startingHandSize?: number;
  openingCards?: "hand" | "hidden_deck";
  turnOrder?: GameContract["turnOrder"];
  includeDiscard?: boolean;
  allowedActions?: ActionName[];
}

export interface LobbyToolHandlers {
  getDraft: () => GameContract;
  setDraft: (draft: GameContract) => void;
  requestStart: (signal: AbortSignal) => Promise<{ roomId: string; inviteUrl: string }>;
}

export interface TableToolHandlers {
  getView: () => TableView;
  executeAction: (action: TableAction, signal: AbortSignal) => Promise<TableView>;
}

const stringArray = (values: readonly string[]): JsonSchema => ({ type: "array", minItems: 1, maxItems: 13, uniqueItems: true, items: { type: "string", enum: values } });
const cardIdsSchema: JsonSchema = { type: "array", minItems: 1, maxItems: 26, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } };
const zoneSchema: JsonSchema = { type: "string", minLength: 1, maxLength: 30 };

export function activeModelContext(): WebMcpContext | null {
  return typeof document === "undefined" ? null : document.modelContext ?? null;
}

export function registerLobbyTools(context: WebMcpContext, handlers: LobbyToolHandlers, signal: AbortSignal): void {
  void context.registerTool({
    name: "draft_table",
    title: "Draft a card table",
    description: "Choose a suggested game or update the visible prompt-defined table draft. This does not create a room.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        preset: { type: "string", enum: GAME_PRESETS.map((preset) => preset.id) },
        name: { type: "string", minLength: 1, maxLength: 80 },
        gamePrompt: { type: "string", minLength: 1, maxLength: 2_000 },
        startingHandSize: { type: "integer", minimum: 0, maximum: 26 },
        openingCards: { type: "string", enum: ["hand", "hidden_deck"] },
        turnOrder: { type: "string", enum: ["alternating", "manual"] },
        includeDiscard: { type: "boolean" },
        allowedActions: stringArray(["deal", "draw", "move", "play_next", "collect", "give", "reveal", "shuffle", "announce", "react", "end_turn"]),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: true },
    execute: async (input: DraftTableInput) => {
      const preset = input.preset === undefined ? undefined : GAME_PRESETS.find((candidate) => candidate.id === input.preset);
      const current = preset ? structuredClone(preset.contract) : handlers.getDraft();
      let zones = input.includeDiscard === undefined
        ? current.zones
        : input.includeDiscard
          ? current.zones.some((zone) => zone.id === "discard")
            ? current.zones
            : [...current.zones, { id: "discard", kind: "discard" as const, facing: "up" as const, scope: "shared" as const, visibility: "public" as const, ordered: true }]
          : current.zones.filter((zone) => zone.id !== "discard");
      if (input.openingCards === "hidden_deck" && !zones.some((zone) => zone.id === "deck" && zone.scope === "seat")) {
        zones = [...zones, { id: "deck", kind: "pile", facing: "down", scope: "seat", visibility: "hidden", ordered: true }];
      }
      if (input.openingCards === "hand") zones = zones.filter((zone) => !(zone.id === "deck" && zone.scope === "seat"));
      const next = validateContract({
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.gamePrompt === undefined ? {} : { gamePrompt: input.gamePrompt }),
        ...(input.startingHandSize === undefined ? {} : { startingHandSize: input.startingHandSize }),
        ...(input.openingCards === undefined ? {} : { startingZoneId: input.openingCards === "hidden_deck" ? "deck" : "hand" }),
        ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
        ...(input.allowedActions === undefined ? {} : { allowedActions: input.allowedActions }),
        zones,
      });
      handlers.setDraft(next);
      return bounded({ status: "drafted", draft: contractSummary(next), next: "Call start_table when the human is ready to approve room creation." });
    },
  }, { signal });

  void context.registerTool({
    name: "start_table",
    title: "Open the drafted table",
    description: "Ask the human to approve shuffling, dealing, and creating the visible private table. Waits for an in-page decision.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
    execute: async (_input: Record<string, unknown>, execution) => {
      const room = await handlers.requestStart(toolSignal(execution));
      return bounded({ status: "created", roomId: room.roomId, inviteUrl: room.inviteUrl });
    },
  }, { signal });
}

export function registerTableTools(context: WebMcpContext, handlers: TableToolHandlers, signal: AbortSignal): void {
  const view = handlers.getView();
  register(context, signal, {
    name: "inspect_table",
    title: "Inspect the card table",
    description: "Read your private hand, personal zones, public zones, turn state, rules, and recent public events.",
    inputSchema: emptySchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
    execute: () => bounded(viewSummary(handlers.getView())),
  });

  const allowed = new Set(view.contract.allowedActions);
  if (allowed.has("deal")) registerAction(context, signal, handlers, "deal_cards", "Deal cards", "Deal the same number of cards from a public pile to each seat.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema, countPerSeat: { type: "integer", minimum: 1, maximum: 26 } }, required: ["zoneId", "countPerSeat"],
  }, (input) => ({ type: "deal", zoneId: String(input.zoneId), countPerSeat: Number(input.countPerSeat) }));
  if (allowed.has("draw")) registerAction(context, signal, handlers, "draw_cards", "Draw cards", "Draw cards from a public pile into your private hand.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema, count: { type: "integer", minimum: 1, maximum: 13 } }, required: ["zoneId", "count"],
  }, (input) => ({ type: "draw", zoneId: String(input.zoneId), count: Number(input.count) }));
  if (allowed.has("move")) registerAction(context, signal, handlers, "move_cards", "Move cards", "Move cards from your hand to a public pile, face up or face down.", {
    type: "object", additionalProperties: false, properties: { cardIds: cardIdsSchema, zoneId: zoneSchema, face: { type: "string", enum: ["up", "down"] } }, required: ["cardIds", "zoneId", "face"],
  }, (input) => ({ type: "move", cardIds: input.cardIds as string[], zoneId: String(input.zoneId), face: input.face as "up" | "down" }));
  if (allowed.has("play_next")) registerAction(context, signal, handlers, "play_next_card", "Play the next card", "Move the next card from one of your ordered personal piles to a public pile without choosing or inspecting it first.", {
    type: "object", additionalProperties: false, properties: { sourceZoneId: zoneSchema, targetZoneId: zoneSchema, face: { type: "string", enum: ["up", "down"] } }, required: ["sourceZoneId", "targetZoneId", "face"],
  }, (input) => ({ type: "play_next", sourceZoneId: String(input.sourceZoneId), targetZoneId: String(input.targetZoneId), face: input.face as "up" | "down" }));
  if (allowed.has("collect")) registerAction(context, signal, handlers, "collect_pile", "Collect a public pile", "Move every card from a public pile to the top or bottom of one of your ordered personal piles.", {
    type: "object", additionalProperties: false, properties: { sourceZoneId: zoneSchema, targetZoneId: zoneSchema, placement: { type: "string", enum: ["top", "bottom"] } }, required: ["sourceZoneId", "targetZoneId", "placement"],
  }, (input) => ({ type: "collect", sourceZoneId: String(input.sourceZoneId), targetZoneId: String(input.targetZoneId), placement: input.placement as "top" | "bottom" }));
  if (allowed.has("give")) registerAction(context, signal, handlers, "give_cards", "Give cards", "Give cards from your hand to the other seat.", {
    type: "object", additionalProperties: false, properties: { cardIds: cardIdsSchema }, required: ["cardIds"],
  }, (input) => ({ type: "give", cardIds: input.cardIds as string[], targetSeatId: handlers.getView().opponent.seatId }));
  if (allowed.has("reveal")) registerReveal(context, signal, handlers);
  if (allowed.has("shuffle")) registerAction(context, signal, handlers, "shuffle_pile", "Shuffle a pile", "Cryptographically shuffle a public pile. Card identities stay opaque.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema }, required: ["zoneId"],
  }, (input) => ({ type: "shuffle", zoneId: String(input.zoneId) }));
  if (allowed.has("announce")) registerAction(context, signal, handlers, "announce", "Speak at the table", "Send a short public game message to coordinate a request, declaration, or result.", {
    type: "object", additionalProperties: false, properties: { message: { type: "string", minLength: 1, maxLength: 160 } }, required: ["message"],
  }, (input) => ({ type: "announce", message: String(input.message) }), false);
  if (allowed.has("end_turn")) registerAction(context, signal, handlers, "end_turn", "End the turn", "Pass an alternating turn to the other seat, or record a pass at a manual table.", emptySchema(), () => ({ type: "end_turn" }));
  if (allowed.has("react")) registerReact(context, signal, handlers);
}

function registerReveal(context: WebMcpContext, signal: AbortSignal, handlers: TableToolHandlers): void {
  registerAction(context, signal, handlers, "reveal_cards", "Reveal cards", "Publicly reveal selected cards from your hand without moving them.", {
    type: "object", additionalProperties: false, properties: { cardIds: cardIdsSchema }, required: ["cardIds"],
  }, (input) => ({ type: "reveal", cardIds: input.cardIds as string[] }));
}

function registerReact(context: WebMcpContext, signal: AbortSignal, handlers: TableToolHandlers): void {
  registerAction(context, signal, handlers, "react", "React at the table", "Send one fixed, non-text reaction to the other seat.", {
    type: "object", additionalProperties: false, properties: { reaction: { type: "string", enum: REACTIONS } }, required: ["reaction"],
  }, (input) => ({ type: "react", reaction: input.reaction as Reaction }), false);
}

function registerAction(
  context: WebMcpContext,
  signal: AbortSignal,
  handlers: TableToolHandlers,
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  action: (input: Record<string, unknown>) => TableAction,
  destructiveHint = true,
): void {
  register(context, signal, {
    name, title, description, inputSchema,
    annotations: { readOnlyHint: false, destructiveHint, untrustedContentHint: true },
    execute: async (input, execution) => bounded(viewSummary(await handlers.executeAction(action(input), toolSignal(execution)))),
  });
}

function register(context: WebMcpContext, signal: AbortSignal, tool: WebMcpTool): void {
  void context.registerTool(tool, { signal });
}

function emptySchema(): JsonSchema {
  return { type: "object", additionalProperties: false, properties: {} };
}

function toolSignal(execution?: { signal?: AbortSignal }): AbortSignal {
  return execution?.signal ?? new AbortController().signal;
}

function contractSummary(contract: GameContract) {
  return {
    name: contract.name,
    gamePrompt: contract.gamePrompt,
    startingHandSize: contract.startingHandSize,
    startingZoneId: contract.startingZoneId,
    turnOrder: contract.turnOrder,
    zones: contract.zones,
    allowedActions: contract.allowedActions,
  };
}

function viewSummary(view: TableView) {
  return {
    roomId: view.roomId,
    revision: view.revision,
    status: view.status,
    activeSeatId: view.activeSeatId,
    yourSeatId: view.self.seatId,
    yourHand: view.self.hand.map((card) => ({ id: card.id, rank: card.rank, suit: card.suit })),
    yourZones: view.self.zones.map((zone) => ({ zoneId: zone.zoneId, kind: zone.kind, visibility: zone.visibility, ordered: zone.ordered, cardCount: zone.cardCount, topCard: zone.cards.at(-1) })),
    opponent: { seatId: view.opponent.seatId, handCardCount: view.opponent.cardCount, zones: view.opponent.zones },
    publicZones: view.publicZones.map((zone) => ({ zoneId: zone.zoneId, kind: zone.kind, ordered: zone.ordered, cardCount: zone.cardCount, topCard: zone.cards.at(-1) })),
    rules: contractSummary(view.contract),
    recentEvents: view.recentEvents.slice(-5).map(eventSummary),
  };
}

function eventSummary(event: TableEvent) {
  return { revision: event.revision, type: event.type, actorSeatId: event.actorSeatId, data: event.data };
}

function bounded(value: unknown): string {
  const output = JSON.stringify(value);
  if (output.length <= 3_500) return output;
  return JSON.stringify({ truncated: true, summary: output.slice(0, 3_300) });
}

export function freshFreePlayDraft(): GameContract {
  return structuredClone(DEFAULT_FREE_PLAY_CONTRACT);
}
