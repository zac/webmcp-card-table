import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FREE_PLAY_CONTRACT, PRACTICE_CONTRACT, type TableView } from "../shared";
import { registerLobbyTools, registerTableTools, type WebMcpContext, type WebMcpTool } from "./webmcp";

function registry() {
  const tools = new Map<string, WebMcpTool>();
  const signals = new Map<string, AbortSignal | undefined>();
  const context: WebMcpContext = { registerTool(tool, options) { tools.set(tool.name, tool); signals.set(tool.name, options?.signal); } };
  return { context, tools, signals };
}

function view(kind: "free_play" | "go_fish" = "free_play"): TableView {
  const contract = kind === "go_fish" ? PRACTICE_CONTRACT : DEFAULT_FREE_PLAY_CONTRACT;
  return {
    roomId: "room-1", revision: 3, contract, activeSeatId: kind === "go_fish" ? "human" : "host", status: "active", winnerSeatId: null,
    self: { seatId: kind === "go_fish" ? "human" : "host", hand: [{ id: "opaque-1", rank: "A", suit: "spades" }], books: kind === "go_fish" ? [] : undefined },
    opponent: { seatId: kind === "go_fish" ? "house" : "guest", cardCount: 7, bookCount: kind === "go_fish" ? 0 : undefined },
    publicZones: [{ zoneId: "stock", kind: "stock", cardCount: 37, cards: [{ id: "opaque-2", face: "down" }] }], recentEvents: [],
  };
}

describe("WebMCP lobby tools", () => {
  it("drafts visibly without creating and requires start approval", async () => {
    const { context, tools, signals } = registry();
    let draft = structuredClone(DEFAULT_FREE_PLAY_CONTRACT);
    const requestStart = vi.fn(async () => ({ roomId: "room-2", inviteUrl: "https://example.test/#invite=secret" }));
    const lifecycle = new AbortController();
    registerLobbyTools(context, { getDraft: () => draft, setDraft: (next) => { draft = next; }, requestStart }, lifecycle.signal);

    const draftResult = await tools.get("draft_table")!.execute({ name: "Rummy night", startingHandSize: 10 }, { signal: new AbortController().signal });
    expect(draft.name).toBe("Rummy night");
    expect(draft.startingHandSize).toBe(10);
    expect(requestStart).not.toHaveBeenCalled();
    expect(JSON.parse(draftResult)).toMatchObject({ status: "drafted" });

    const execution = new AbortController();
    await tools.get("start_table")!.execute({}, { signal: execution.signal });
    expect(requestStart).toHaveBeenCalledWith(execution.signal);
    expect(signals.get("start_table")).toBe(lifecycle.signal);
  });
});

describe("WebMCP table tools", () => {
  it("matches free-play actions and forwards cancellation", async () => {
    const { context, tools } = registry();
    let current = view();
    const executeAction = vi.fn(async () => ({ ...current, revision: 4 }));
    registerTableTools(context, { getView: () => current, executeAction }, new AbortController().signal);

    expect([...tools.keys()].sort()).toEqual(["deal_cards", "draw_cards", "end_turn", "give_cards", "inspect_table", "move_cards", "react", "reveal_cards", "shuffle_pile"]);
    expect(tools.get("inspect_table")?.annotations?.readOnlyHint).toBe(true);
    const execution = new AbortController();
    await tools.get("draw_cards")!.execute({ zoneId: "stock", count: 2 }, { signal: execution.signal });
    expect(executeAction).toHaveBeenCalledWith({ type: "draw", zoneId: "stock", count: 2 }, execution.signal);
    current = { ...current, revision: 5 };
  });

  it("exposes only pinned Go Fish actions", () => {
    const { context, tools } = registry();
    registerTableTools(context, { getView: () => view("go_fish"), executeAction: vi.fn() }, new AbortController().signal);
    expect([...tools.keys()].sort()).toEqual(["inspect_table", "react", "request_rank", "reveal_cards"]);
    expect(tools.has("end_turn")).toBe(false);
    expect(tools.has("draw_cards")).toBe(false);
  });
});
