import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, type TableView } from "../shared";
import { registerLobbyTools, registerTableTools, type WebMcpContext, type WebMcpTool } from "./webmcp";

function registry() {
  const tools = new Map<string, WebMcpTool>();
  const signals = new Map<string, AbortSignal | undefined>();
  const context: WebMcpContext = { registerTool(tool, options) { tools.set(tool.name, tool); signals.set(tool.name, options?.signal); } };
  return { context, tools, signals };
}

function view(): TableView {
  const contract = DEFAULT_FREE_PLAY_CONTRACT;
  return {
    roomId: "room-1", revision: 3, contract, activeSeatId: "host", status: "active", winnerSeatId: null,
    self: { seatId: "host", hand: [{ id: "opaque-1", rank: "A", suit: "spades" }], zones: [] },
    opponent: { seatId: "guest", presence: "online", cardCount: 7, zones: [] },
    publicZones: [{ zoneId: "stock", ownerSeatId: null, kind: "stock", ordered: true, cardCount: 37, cards: [{ id: "opaque-2", face: "down" }] }], recentEvents: [],
  };
}

describe("WebMCP lobby tools", () => {
  it("drafts visibly without creating and requires start approval", async () => {
    const { context, tools, signals } = registry();
    let draft = structuredClone(DEFAULT_FREE_PLAY_CONTRACT);
    const requestStart = vi.fn(async () => ({ roomId: "room-2", inviteUrl: "https://example.test/#invite=secret" }));
    const lifecycle = new AbortController();
    registerLobbyTools(context, { getDraft: () => draft, setDraft: (next) => { draft = next; }, requestStart }, lifecycle.signal);

    const draftResult = await tools.get("draft_table")!.execute({ preset: "crazy_eights", name: "Friday eights" }, { signal: new AbortController().signal });
    expect(draft.name).toBe("Friday eights");
    expect(draft.gamePrompt).toContain("Crazy Eights");
    expect(requestStart).not.toHaveBeenCalled();
    expect(JSON.parse(draftResult)).toMatchObject({ status: "drafted" });

    const execution = new AbortController();
    await tools.get("start_table")!.execute({}, { signal: execution.signal });
    expect(requestStart).toHaveBeenCalledWith(execution.signal);
    expect(signals.get("start_table")).toBe(lifecycle.signal);
  });

  it("can draft an owner-hidden opening deck without creating a game-specific mode", async () => {
    const { context, tools } = registry();
    let draft = structuredClone(DEFAULT_FREE_PLAY_CONTRACT);
    registerLobbyTools(context, {
      getDraft: () => draft,
      setDraft: (next) => { draft = next; },
      requestStart: vi.fn(),
    }, new AbortController().signal);
    await tools.get("draft_table")!.execute({ openingCards: "hidden_deck", startingHandSize: 26 });
    expect(draft.startingZoneId).toBe("deck");
    expect(draft.zones).toContainEqual({ id: "deck", kind: "pile", facing: "down", scope: "seat", visibility: "hidden", ordered: true });
  });
});

describe("WebMCP table tools", () => {
  it("matches free-play actions and forwards cancellation", async () => {
    const { context, tools } = registry();
    let current = view();
    const executeAction = vi.fn(async () => ({ ...current, revision: 4 }));
    const requestFinish = vi.fn(async () => ({ ...current, revision: 4, status: "finished" as const }));
    registerTableTools(context, { getView: () => current, executeAction, requestFinish }, new AbortController().signal);

    expect([...tools.keys()].sort()).toEqual(["announce", "collect_pile", "deal_cards", "draw_cards", "end_turn", "finish_table", "give_cards", "inspect_table", "move_cards", "play_next_card", "react", "reveal_cards", "shuffle_pile"]);
    expect(tools.get("inspect_table")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("announce")?.annotations).toMatchObject({ destructiveHint: false, untrustedContentHint: true });
    const execution = new AbortController();
    await tools.get("draw_cards")!.execute({ zoneId: "stock", count: 2 }, { signal: execution.signal });
    expect(executeAction).toHaveBeenCalledWith({ type: "draw", zoneId: "stock", count: 2 }, execution.signal);
    await tools.get("finish_table")!.execute({}, { signal: execution.signal });
    expect(requestFinish).toHaveBeenCalledWith(execution.signal);
    expect(tools.get("finish_table")?.annotations).toMatchObject({ destructiveHint: true, untrustedContentHint: false });
    current = { ...current, revision: 5 };
  });

  it("registers only actions enabled by the prompt-defined contract", () => {
    const { context, tools } = registry();
    const current = view();
    current.contract = { ...current.contract, allowedActions: ["announce", "reveal"] };
    registerTableTools(context, { getView: () => current, executeAction: vi.fn(), requestFinish: vi.fn() }, new AbortController().signal);
    expect([...tools.keys()].sort()).toEqual(["announce", "finish_table", "inspect_table", "reveal_cards"]);
    expect(tools.has("end_turn")).toBe(false);
    expect(tools.has("draw_cards")).toBe(false);
  });

  it("registers generic ordered-pile tools for a War-style contract", async () => {
    const { context, tools } = registry();
    const current = view();
    current.contract = { ...current.contract, allowedActions: ["play_next", "collect"] };
    current.self.zones = [{ zoneId: "deck", kind: "pile", visibility: "hidden", ordered: true, cardCount: 26, cards: [] }];
    current.opponent.zones = [{ zoneId: "deck", kind: "pile", ordered: true, cardCount: 26 }];
    current.publicZones.push({ zoneId: "battle", ownerSeatId: "host", kind: "pile", ordered: true, cardCount: 0, cards: [] });
    current.publicZones.push({ zoneId: "battle", ownerSeatId: "guest", kind: "pile", ordered: true, cardCount: 1, cards: [{ id: "guest-card", face: "up", rank: "K", suit: "clubs" }] });
    const executeAction = vi.fn(async () => ({ ...current, revision: 4 }));
    registerTableTools(context, { getView: () => current, executeAction, requestFinish: vi.fn() }, new AbortController().signal);
    expect([...tools.keys()].sort()).toEqual(["collect_pile", "finish_table", "inspect_table", "play_next_card"]);
    await tools.get("play_next_card")!.execute({ sourceZoneId: "deck", targetZoneId: "battle", face: "up" });
    expect(executeAction).toHaveBeenCalledWith({ type: "play_next", sourceZoneId: "deck", targetZoneId: "battle", face: "up" }, expect.any(AbortSignal));
    await tools.get("collect_pile")!.execute({ sourceZoneId: "battle", sourceSeatId: "guest", targetZoneId: "deck", placement: "bottom" });
    expect(executeAction).toHaveBeenCalledWith({ type: "collect", sourceZoneId: "battle", sourceSeatId: "guest", targetZoneId: "deck", placement: "bottom" }, expect.any(AbortSignal));
  });

  it("keeps finish host-only and exposes only inspection after a game ends", () => {
    const guestRegistry = registry();
    const guest = view();
    guest.self.seatId = "guest";
    guest.opponent.seatId = "host";
    registerTableTools(guestRegistry.context, { getView: () => guest, executeAction: vi.fn(), requestFinish: vi.fn() }, new AbortController().signal);
    expect(guestRegistry.tools.has("finish_table")).toBe(false);

    const finishedRegistry = registry();
    const finished = { ...view(), status: "finished" as const, activeSeatId: null };
    registerTableTools(finishedRegistry.context, { getView: () => finished, executeAction: vi.fn(), requestFinish: vi.fn() }, new AbortController().signal);
    expect([...finishedRegistry.tools.keys()]).toEqual(["inspect_table"]);
  });
});
