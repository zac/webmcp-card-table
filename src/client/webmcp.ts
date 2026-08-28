import {
  DEFAULT_FREE_PLAY_CONTRACT,
  RANKS,
  REACTIONS,
  validateContract,
  type ActionName,
  type GameContract,
  type Rank,
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
  name?: string;
  objective?: string;
  startingHandSize?: number;
  turnOrder?: GameContract["turnOrder"];
  includeDiscard?: boolean;
  allowedActions?: ActionName[];
  winCondition?: string;
  note?: string;
}

export interface LobbyToolHandlers {
  getDraft: () => GameContract;
  setDraft: (draft: GameContract) => void;
  requestStart: (signal: AbortSignal) => Promise<{ roomId: string; inviteUrl?: string }>;
}

export interface TableToolHandlers {
  getView: () => TableView;
  executeAction: (action: TableAction, signal: AbortSignal) => Promise<TableView>;
}

const stringArray = (values: readonly string[]): JsonSchema => ({ type: "array", minItems: 1, maxItems: 13, uniqueItems: true, items: { type: "string", enum: values } });
const cardIdsSchema: JsonSchema = { type: "array", minItems: 1, maxItems: 13, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } };
const zoneSchema: JsonSchema = { type: "string", minLength: 1, maxLength: 30 };

export function activeModelContext(): WebMcpContext | null {
  return typeof document === "undefined" ? null : document.modelContext ?? null;
}

export function registerLobbyTools(context: WebMcpContext, handlers: LobbyToolHandlers, signal: AbortSignal): void {
  void context.registerTool({
    name: "draft_table",
    title: "Draft a card table",
    description: "Update the visible two-player free-play table draft. This does not create a room.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        objective: { type: "string", minLength: 1, maxLength: 280 },
        startingHandSize: { type: "integer", minimum: 0, maximum: 13 },
        turnOrder: { type: "string", enum: ["alternating", "manual"] },
        includeDiscard: { type: "boolean" },
        allowedActions: stringArray(["deal", "draw", "move", "give", "reveal", "shuffle", "react", "end_turn"]),
        winCondition: { type: "string", minLength: 1, maxLength: 280 },
        note: { type: "string", maxLength: 280 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: true },
    execute: async (input: DraftTableInput) => {
      const current = handlers.getDraft();
      const zones = input.includeDiscard === undefined
        ? current.zones
        : input.includeDiscard
          ? [{ id: "stock", kind: "stock" as const, facing: "down" as const }, { id: "discard", kind: "discard" as const, facing: "up" as const }]
          : [{ id: "stock", kind: "stock" as const, facing: "down" as const }];
      const next = validateContract({
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.startingHandSize === undefined ? {} : { startingHandSize: input.startingHandSize }),
        ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
        ...(input.allowedActions === undefined ? {} : { allowedActions: input.allowedActions }),
        ...(input.winCondition === undefined ? {} : { winCondition: input.winCondition }),
        ...(input.note === undefined ? {} : { note: input.note }),
        zones,
      });
      handlers.setDraft(next);
      return bounded({ status: "drafted", draft: contractSummary(next), next: "Call start_table when the human is ready to approve room creation." });
    },
  }, { signal });

  void context.registerTool({
    name: "start_table",
    title: "Open the drafted table",
    description: "Ask the human to approve creating the visible free-play draft. Waits for an in-page decision.",
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
    description: "Read your private hand, public zones, turn state, rules, and recent public events.",
    inputSchema: emptySchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
    execute: () => bounded(viewSummary(handlers.getView())),
  });

  if (view.contract.kind === "go_fish") {
    registerAction(context, signal, handlers, "request_rank", "Request a Go Fish rank", "Ask the house for a rank held in your hand. This action alone advances or keeps the turn.", {
      type: "object", additionalProperties: false, properties: { rank: { type: "string", enum: RANKS } }, required: ["rank"],
    }, (input) => ({ type: "request_rank", rank: input.rank as Rank }));
    if (view.contract.allowedActions.includes("reveal")) registerReveal(context, signal, handlers);
    if (view.contract.allowedActions.includes("react")) registerReact(context, signal, handlers);
    return;
  }

  const allowed = new Set(view.contract.allowedActions);
  if (allowed.has("deal")) registerAction(context, signal, handlers, "deal_cards", "Deal cards", "Deal the same number of cards from a public pile to each seat.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema, countPerSeat: { type: "integer", minimum: 1, maximum: 13 } }, required: ["zoneId", "countPerSeat"],
  }, (input) => ({ type: "deal", zoneId: String(input.zoneId), countPerSeat: Number(input.countPerSeat) }));
  if (allowed.has("draw")) registerAction(context, signal, handlers, "draw_cards", "Draw cards", "Draw cards from a public pile into your private hand.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema, count: { type: "integer", minimum: 1, maximum: 13 } }, required: ["zoneId", "count"],
  }, (input) => ({ type: "draw", zoneId: String(input.zoneId), count: Number(input.count) }));
  if (allowed.has("move")) registerAction(context, signal, handlers, "move_cards", "Move cards", "Move cards from your hand to a public pile, face up or face down.", {
    type: "object", additionalProperties: false, properties: { cardIds: cardIdsSchema, zoneId: zoneSchema, face: { type: "string", enum: ["up", "down"] } }, required: ["cardIds", "zoneId", "face"],
  }, (input) => ({ type: "move", cardIds: input.cardIds as string[], zoneId: String(input.zoneId), face: input.face as "up" | "down" }));
  if (allowed.has("give")) registerAction(context, signal, handlers, "give_cards", "Give cards", "Give cards from your hand to the other seat.", {
    type: "object", additionalProperties: false, properties: { cardIds: cardIdsSchema }, required: ["cardIds"],
  }, (input) => ({ type: "give", cardIds: input.cardIds as string[], targetSeatId: handlers.getView().opponent.seatId }));
  if (allowed.has("reveal")) registerReveal(context, signal, handlers);
  if (allowed.has("shuffle")) registerAction(context, signal, handlers, "shuffle_pile", "Shuffle a pile", "Cryptographically shuffle a public pile. Card identities stay opaque.", {
    type: "object", additionalProperties: false, properties: { zoneId: zoneSchema }, required: ["zoneId"],
  }, (input) => ({ type: "shuffle", zoneId: String(input.zoneId) }));
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
  }, (input) => ({ type: "react", reaction: input.reaction as Reaction }));
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
): void {
  register(context, signal, {
    name, title, description, inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, untrustedContentHint: true },
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
    kind: contract.kind,
    name: contract.name,
    objective: contract.objective,
    startingHandSize: contract.startingHandSize,
    turnOrder: contract.turnOrder,
    zones: contract.zones,
    allowedActions: contract.allowedActions,
    winCondition: contract.winCondition,
    ...(contract.note ? { note: contract.note } : {}),
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
    yourBookCount: view.self.books?.length,
    opponent: { seatId: view.opponent.seatId, cardCount: view.opponent.cardCount, bookCount: view.opponent.bookCount },
    publicZones: view.publicZones.map((zone) => ({ zoneId: zone.zoneId, kind: zone.kind, cardCount: zone.cardCount, topCard: zone.cards.at(-1) })),
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
