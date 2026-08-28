# WebMCP playing-card table

## Summary

Build an original two-seat playing-card table where humans coach browser agents through one turn at a time. The product uses a standard 52-card deck, not Magic assets or rules.

The submission has two modes:

- **Practice Go Fish.** A reliable solo match against a deterministic house player.
- **Free play.** Two people join through an invite link and use generic deck, hand, pile, reveal, transfer, shuffle, and turn operations under a structured rules contract.

The core pitch is: existing card tables are mouse-first and opaque to agents. This table gives agents typed operations while the server protects hidden hands, ownership, and shared state.

Success means a judge can open the live URL, start practice mode, ask ChatGPT or Codex to play one turn, and watch the table update correctly without setup or another person.

## Product experience

- Use a modern dark card-table presentation with original CSS and SVG playing cards, restrained animations, turn status, books, piles, and a structured event log.
- Provide direct human controls for every operation exposed through WebMCP. Agent actions and human actions must use the same application reducer and server endpoint.
- In the lobby, register `draft_table`. A host can ask their agent to configure a table using a bounded contract containing:
  - Game name and objective
  - Exactly two seats (fixed; not configurable)
  - Starting hand size from 0 through 13
  - Alternating or manual turns
  - Enabled piles and face-up or face-down play
  - Allowed generic operations
  - Win condition
  - Optional 280-character note
- Render the draft visually before creation. `start_table` validates the current draft and opens an in-page approval dialog; its promise resolves with the room and invite URL only after the human clicks Approve, rejects if the human declines, and cancels cleanly through the execution `AbortSignal`. The agent can never create a room without a human click.
- Practice mode starts a fixed two-player Go Fish contract with seven-card hands, books of four, and a deterministic house player.
- Free-play rooms expose a single-use invite URL. Remove the invite token from the address bar immediately after redemption.
- Omit arbitrary chat. Show only structured events such as rank requests, transfers, draws, reveals, passes, and reactions. Reactions come from a small fixed set (no free text), so nothing a player sends can carry arbitrary content.

## Game rules

### Turn order semantics

- **Alternating:** exactly one active seat at a time. The server rejects actions from the inactive seat; `end_turn` passes control.
- **Manual:** `activeSeatId` is `null`, turn checks are skipped, and either seat may act at any time; `end_turn` emits a pass event only. Intended for casual free-play games where the humans referee themselves.

### Go Fish (practice mode)

Pin the variant explicitly so the adapter, house player, and tests agree:

- A seat may only request a rank it currently holds at least one card of.
- On a catch, the opponent transfers every card of that rank and the asker goes again.
- On a miss, the asker draws one card from the stock ("go fish"). If the drawn card is the requested rank, it is revealed and the asker goes again; otherwise the turn passes.
- Books of four are laid down automatically the moment they form, including immediately after the deal.
- If the stock is empty, a miss simply passes the turn with no draw.
- If a seat starts its turn with an empty hand, it draws one card from the stock; if the stock is also empty, it passes.
- The game ends when all thirteen books are made. The seat with more books wins (thirteen is odd, so no ties).

The house player chooses the rank it holds the most copies of, breaking ties by rank order (aces low), so every game is reproducible. It uses no model API and runs entirely inside the Durable Object: after the human's turn ends, house actions are paced by a short (~1 second) Durable Object alarm per action so the event log reads naturally, with state persisted after each step. The house seat has no cookie or HTTP surface.

## Architecture and interfaces

- Use a Vite React TypeScript SPA, Cloudflare Worker, Workers Static Assets, and one SQLite-backed `GameRoom` Durable Object per room (id derived via `idFromName(roomId)`). Cloudflare recommends one object per game session and hibernatable WebSockets for persistent room connections.[ ](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)[ ](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Persist a versioned JSON game snapshot and structured event records in SQLite before broadcasting updates. Never depend on in-memory state surviving hibernation.
- Authenticate each seat with an opaque, room-scoped, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Store only hashed session and invite tokens. The WebSocket upgrade authenticates with the same cookie and is bound to a seat before any messages flow.
- Give every card an opaque random ID unique to the room. Rank and suit serialize only when the card is in the caller's own hand or books, or face-up in a public zone. Face-down cards in public zones serialize as bare IDs and counts. (A player who watched a specific face-down card move may track its ID — the same information a physical table leaks — but never its identity.)
- Keep opponent hands entirely out of that seat's HTTP responses, WebSocket messages, DOM, and WebMCP results.
- Expire rooms after 24 hours of inactivity through a Durable Object alarm; every accepted action resets the clock.
- Use these HTTP interfaces:
  - `POST /api/rooms` creates a practice or free-play room and sets the host's seat cookie.
  - `POST /api/rooms/:id/redeem` exchanges a single-use invite token for the second-seat cookie.
  - `GET /api/rooms/:id/view` returns the caller's seat-scoped view.
  - `POST /api/rooms/:id/actions` accepts `{ actionId, expectedRevision, action }`.
  - `GET /api/rooms/:id/socket` upgrades to a hibernatable WebSocket. On connect the client sends its last known revision; the server replies with a full seat-scoped snapshot if the client is stale, then streams incremental events.
- Reject duplicate action IDs, stale revisions, actions from the wrong seat, card IDs the caller does not own, invalid zone transitions, out-of-range draw counts, actions not in the contract's `allowedActions`, and actions taken out of turn.

Core public types:

```ts
type GameKind = "go_fish" | "free_play";

type GenericActionName =
  | "draw" | "move" | "give" | "reveal" | "shuffle" | "react" | "end_turn";
type GoFishActionName = "request_rank";

interface ZoneConfig {
  id: string;
  kind: "stock" | "discard" | "pile";
  facing: "up" | "down";
}

interface GameContract {
  kind: GameKind;
  name: string;
  objective: string;
  startingHandSize: number; // 0–13
  turnOrder: "alternating" | "manual";
  zones: ZoneConfig[]; // a stock zone is always present
  allowedActions: (GenericActionName | GoFishActionName)[];
  winCondition: string;
  note?: string; // ≤ 280 characters
}

interface PublicZoneView {
  zoneId: string;
  kind: ZoneConfig["kind"];
  cardCount: number;
  faceUp: CardView[]; // face-down cards contribute to cardCount only
}

interface TableView {
  roomId: string;
  revision: number;
  contract: GameContract;
  activeSeatId: string | null; // null under manual turn order
  self: { seatId: string; hand: CardView[]; books?: CardView[][] };
  opponent: { seatId: string; cardCount: number; bookCount?: number };
  publicZones: PublicZoneView[];
  recentEvents: TableEvent[];
}

type TableAction =
  | { type: "draw"; zoneId: string; count: number } // 1–13, capped at zone size
  | { type: "move"; cardIds: string[]; zoneId: string; face: "up" | "down" }
  | { type: "give"; cardIds: string[]; targetSeatId: string }
  | { type: "reveal"; cardIds: string[] } // announce cards from hand without moving them
  | { type: "shuffle"; zoneId: string }
  | { type: "react"; reaction: "well_played" | "thinking" | "ouch" | "gg" }
  | { type: "end_turn" }
  | { type: "request_rank"; rank: Rank }; // go_fish only
```

`books` and `bookCount` are populated only for Go Fish; free-play contracts omit them. The practice contract's `allowedActions` is `["request_rank", "reveal", "react", "end_turn"]` — draws and transfers happen inside the atomic `request_rank` resolution, never as separate agent actions.

Register these browser-native tools through `document.modelContext.registerTool`:

- Lobby: `draft_table`, `start_table`
- Table: `inspect_table`, `get_rules`, `draw_cards`, `move_cards`, `give_cards`, `reveal_cards`, `shuffle_pile`, `react`, `end_turn`
- Go Fish only: `request_rank` (the generic mutation tools are not registered in practice mode)

Use an `AbortController` to replace route-specific registrations and forward each execution's `AbortSignal` to `fetch`. Mark `inspect_table` and `get_rules` with `readOnlyHint`. Mark host-authored contract text (name, objective, win condition, note) with `untrustedContentHint` wherever a tool returns it. Keep within Chrome's recommended budgets: 30 characters per tool and parameter name, 500 per tool description, 150 per parameter description, 1.5K per tool output.[ ](https://developer.chrome.com/docs/ai/webmcp/imperative-api)[ ](https://developer.chrome.com/docs/ai/webmcp/secure-tools)

The Go Fish adapter atomically handles a rank request, matching-card transfer or draw, automatic books, and turn advancement in a single action, following the rules pinned above.

## Verification and delivery

- Unit-test shuffling, ownership, card conservation, zone visibility, stale revisions, idempotency, turn permissions, manual-mode permissiveness, books, empty stock, empty-hand draws, and Go Fish completion.
- Test seat projection explicitly. No serialized response for one seat may contain the opponent's card IDs, ranks, or suits, and no face-down public card may serialize rank or suit for anyone.
- Test the Durable Object with `@cloudflare/vitest-pool-workers`, including concurrent actions, reconnects and revision resync, hibernation attachments, invite redemption (including double redemption), expiry, and house-player alarm turns.
- Mock `document.modelContext` to test schemas, annotations, registration cleanup, cancellation, and parity between direct UI and WebMCP actions.
- Run browser acceptance in ChatGPT's in-app browser and Chrome with WebMCP enabled:
  - Discover the expected lobby tools.
  - Draft and start a table through an agent, confirming room creation blocks until the human approves.
  - Complete a Go Fish turn through `inspect_table` and `request_rank`.
  - Verify the visible UI and WebSocket event log update.
  - Join a second browser through the invite URL and verify private-hand isolation.
  - Verify the site remains playable when WebMCP is unavailable.
- Include a small prompt evaluation set covering direct requests, ambiguous strategic instructions, incorrect game assumptions, and attempts to reveal the opponent's hand.
- Deploy the SPA and Worker together on `workers.dev`, then test the exact production URL.
- Publish the complete source under MIT with locally generated card visuals and no third-party branded assets. Avoiding Magic removes the fan-content and asset-licensing conflict identified in Wizards' policy.[ ](https://company.wizards.com/en/legal/fancontentpolicy)
- Record a sub-three-minute demo:
  1. Start practice Go Fish.
  2. Ask the agent to inspect the hand and play one turn.
  3. Show the tool calls updating the table.
  4. Show a second invited player receiving the update live.
  5. Briefly show the public repository and WebMCP registration.
- Do not depend on Codex subagents, another live participant, random matchmaking, a server-side model, arbitrary chat, more than two seats, Magic content, deck construction, or comprehensive game-rule enforcement. (Free play validates ownership, zones, and turns — it does not referee whether a move is "legal" in the players' chosen game.)

## Build order

1. **Day 1 — Foundation.** Scaffold Worker, Durable Object, and SPA; room creation, seat cookies, invite redemption; snapshot persistence and the action envelope (`actionId`, `expectedRevision`).
2. **Day 2 — Generic engine.** Zones, all generic actions, seat-scoped projections, WebSocket broadcast and resync; the bulk of the unit tests.
3. **Day 3 — Go Fish.** Adapter, house player with alarm pacing, practice-mode UI and event log.
4. **Day 4 — WebMCP and free play.** Tool registration and lifecycle, lobby draft/approve flow, free-play UI polish, Durable Object tests.
5. **Day 5 — Acceptance and delivery.** Browser acceptance runs, prompt evals, production deploy, README, demo video. Treat day 5 as the buffer; cut the `react` action and free-play polish first if behind.

## Assumptions

- Build budget is four to five focused days.
- The current repository contains only planning documents — no application code and no initialized Devpost workflow.
- `webmcp-card-table` is the internal package name only. The user will choose the public project name before submission.
- The official target remains one deployed open-source web product with a public repository and live browser-native WebMCP tools.[ ](https://webmcp.devpost.com/)
