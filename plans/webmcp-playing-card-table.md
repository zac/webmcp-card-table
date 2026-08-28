# WebMCP Playing-Card Table — Revised Product Plan

## Summary

Build one focused product: a private, prompt-defined two-player table for any game that can be played with a standard 52-card deck. Direct UI controls and browser-native WebMCP tools expose the same product operations.

Go Fish, Crazy Eights, and War are suggested prompts, not distinct application modes. There is no house bot or game-specific rules adapter. This keeps the demonstration centered on the site's WebMCP surface: an agent can understand a user-authored game brief, inspect its private seat, coordinate with another seat, and manipulate shared state safely.

Success means a judge can open the live URL, choose or write a game, approve room creation, copy a guest or player Codex prompt, and watch a legal tool action update both seats in real time.

## Product experience

- The lobby is a single “new table” flow with four starting points: Go Fish, Crazy Eights, War, and Open Table.
- Choosing a preset fills an ordinary game name, prompt, hand size, turn style, zones, and action allow-list. Editing it produces a custom table.
- Advanced settings stay collapsed by default. They expose starting hand size, manual or alternating turns, public zones, and allowed actions.
- `start_table` always waits for an explicit in-page approval dialog. Decline and cancellation reject the pending tool call without creating a room.
- Every room has a one-use fragment invite. The host gets three clear handoffs:
  - Copy invite
  - Copy guest Codex prompt
  - Play my seat with Codex
- The guest redeems the token once; the fragment is immediately cleared.
- The table includes private hands, public piles, turn/connection state, the game brief, direct controls, fixed reactions, and a structured event log.
- A bounded 160-character `announce` operation lets players make in-game requests and declarations. It is public, rendered as text, retained only in bounded room history, and treated as untrusted content.

## Shared contract and reducer

```ts
interface GameContract {
  name: string;                 // 1–80 characters
  gamePrompt: string;           // 1–2,000 characters, untrusted
  startingHandSize: number;     // 0–26
  turnOrder: "alternating" | "manual";
  zones: ZoneConfig[];          // exactly one stock
  allowedActions: ActionName[];
}

type ActionName =
  | "deal" | "draw" | "move" | "give" | "reveal"
  | "shuffle" | "announce" | "react" | "end_turn";
```

- A pure reducer is shared by UI actions, HTTP actions, WebSocket updates, WebMCP calls, and tests.
- Every mutation requires `actionId` and `expectedRevision`.
- Manual turns allow either seat to act; `end_turn` records a pass. Alternating turns enforce one active seat and pass control with `end_turn`.
- The application enforces deck integrity, ownership, visibility, zones, allowed actions, and turn authority. Players enforce the game rules in the brief.
- Cards have opaque randomized IDs. Seat projections include faces for the caller's hand only. Public faces appear only when a card is face-up.

## Cloudflare architecture

- Vite, React, and TypeScript SPA served through Worker Static Assets.
- One SQLite-backed `GameRoom` Durable Object per room, addressed by room ID.
- SQLite stores the versioned snapshot, event history, hashed sessions, hashed invitation, and redemption state.
- Critical state is persisted before any WebSocket broadcast.
- Hibernatable WebSockets store only seat and last-revision attachments.
- A single Durable Object alarm expires the room 24 hours after its latest accepted action.
- No server-side model, random matchmaking, third-party game assets, or external database.

HTTP surface:

- `POST /api/rooms`
- `POST /api/rooms/:roomId/redeem`
- `GET /api/rooms/:roomId/view`
- `POST /api/rooms/:roomId/actions`
- `GET /api/rooms/:roomId/socket`

## Browser-native WebMCP

Register through `document.modelContext`, guarded by feature detection and scoped with an `AbortController`.

Lobby:

- `draft_table`
- `start_table`

Table, filtered by `allowedActions`:

- `inspect_table`
- `deal_cards`
- `draw_cards`
- `move_cards`
- `give_cards`
- `reveal_cards`
- `shuffle_pile`
- `announce`
- `react`
- `end_turn`

Tool schemas and results remain bounded. `inspect_table` is read-only. Mutations use accurate read-only/destructive annotations where supported. Any result containing the game brief or announcements carries `untrustedContentHint`.

## Security and privacy

- Room-scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookies authenticate seats.
- Session and invite values are stored only as hashes.
- Invite tokens are never placed in query strings or server logs.
- Logs contain request metadata only—never bodies, prompts, announcements, cards, cookies, or tokens.
- Opponent card IDs and faces never appear in another seat's HTTP, WebSocket, DOM, or WebMCP projection.
- Player-authored text does not influence authorization, tool registration, reducer rules, network destinations, or secret access.

## Verification and delivery

- Unit-test contracts, prompt/message bounds, card conservation, authorization, revisions, idempotency, ownership, visibility, zones, turns, shuffling, and preset validity.
- Integration-test creation, one-use invitations, room cookie isolation, stale and duplicate actions, WebSocket snapshots/updates, hibernation attachments, expiry, and per-seat projections.
- Test lobby approval, cancellation forwarding, contract-filtered tool registration, structured results, and UI/tool parity.
- Browser-test preset selection, visible drafting, approval/decline, creation, invite copy, Codex handoff copy, announcement UI, actual WebMCP registry contents, tool execution, refresh recovery, responsive layout, and accessibility.
- Run lint, type checking, unit tests, Worker tests, production build, and `wrangler deploy --dry-run` before delivery.
- Publish the MIT-licensed repository and deploy the exact source to `webmcp-card-table`.
- Configure Cloudflare Workers Builds against the public repository and remove redundant GitHub Actions only after a successful Cloudflare build is confirmed.

## Explicitly out of scope

- A Go Fish bot or game-specific transaction engine
- Comprehensive legality enforcement for arbitrary games
- Random matchmaking
- More than two seats
- General chat
- Magic: The Gathering rules, assets, or deck construction
- A server-side model or model API key
- Devpost submission itself
