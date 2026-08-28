# WebMCP Playing-Card Table — Revised Product Plan

## Summary

Build one focused product: a private, prompt-defined two-player table for any game that can be played with a standard 52-card deck. Direct UI controls and browser-native WebMCP tools expose the same product operations.

Go Fish, Crazy Eights, and War are suggested prompts, not distinct application modes. There is no house bot or game-specific rules adapter. This keeps the demonstration centered on the site's WebMCP surface: an agent can understand a user-authored game brief, inspect its private seat, coordinate with another seat, and manipulate shared state safely.

Success means a judge can open the live URL, choose or write a game, approve room creation, copy a guest or player Codex prompt, and watch a legal tool action update both seats in real time.

## Product experience

- The lobby is a single “new table” flow with four starting points: Go Fish, Crazy Eights, War, and Open Table.
- Choosing a preset fills an ordinary game name, prompt, hand size, turn style, zones, and action allow-list. Editing it produces a custom table.
- Advanced settings stay collapsed by default. They expose opening-card count and destination, manual or alternating turns, shared and per-seat zones, and allowed actions.
- `start_table` always waits for an explicit in-page approval dialog. Decline and cancellation reject the pending tool call without creating a room.
- Every room has a one-use fragment invite. The host gets three clear handoffs:
  - Copy invite
  - Copy guest Codex prompt
  - Play my seat with Codex
- The guest redeems the token once; the fragment is immediately cleared.
- The table includes private hands, owner-visible or fully hidden personal piles, shared piles, turn/connection state, the game brief, direct controls, fixed reactions, and a structured event log.
- A bounded 160-character `announce` operation lets players make in-game requests and declarations. It is public, rendered as text, retained only in bounded room history, and treated as untrusted content.
- The host can end the game through a confirmation dialog. This freezes the room rather than deleting it, keeps the final table visible to both seats, and turns the side panel into a read-only revision replay.

## Shared contract and reducer

```ts
interface GameContract {
  name: string;                 // 1–80 characters
  gamePrompt: string;           // 1–2,000 characters, untrusted
  startingHandSize: number;     // 0–26 opening cards per seat
  startingZoneId: string;       // hand or a seat-owned zone
  turnOrder: "alternating" | "manual";
  zones: ZoneConfig[];          // one shared stock, optional seat zones
  allowedActions: ActionName[];
}

type ActionName =
  | "deal" | "draw" | "move" | "play_next" | "collect"
  | "give" | "reveal"
  | "shuffle" | "announce" | "react" | "end_turn";
```

- A pure reducer is shared by UI actions, HTTP actions, WebSocket updates, WebMCP calls, and tests.
- Every mutation requires `actionId` and `expectedRevision`.
- Manual turns allow either seat to act; `end_turn` records a pass. Alternating turns enforce one active seat and pass control with `end_turn`.
- The application enforces deck integrity, ownership, visibility, zones, allowed actions, and turn authority. Players enforce the game rules in the brief.
- A zone is shared or instantiated once per seat. Seat zones can be owner-visible or hidden even from their owner, and can preserve order.
- `play_next` moves the next card from an actor-owned ordered zone without exposing or selecting it. `collect` moves a shared pile to the top or bottom of an actor-owned ordered zone.
- Cards have opaque randomized IDs. Seat projections include faces only for the caller's visible hand and owner-visible zones. Hidden personal zones expose counts only. Shared faces appear only when a card is face-up.

## Cloudflare architecture

- Vite, React, and TypeScript SPA served through Worker Static Assets.
- One SQLite-backed `GameRoom` Durable Object per room, addressed by room ID.
- SQLite stores the current snapshot, up to 250 replay snapshots plus the opening state, event history, hashed sessions, hashed invitation, and redemption state.
- Critical state is persisted before any WebSocket broadcast.
- Hibernatable WebSockets store only seat and last-revision attachments.
- A single Durable Object alarm expires the room 24 hours after its latest accepted action.
- No server-side model, random matchmaking, third-party game assets, or external database.

HTTP surface:

- `POST /api/rooms`
- `POST /api/rooms/:roomId/redeem`
- `GET /api/rooms/:roomId/view`
- `GET /api/rooms/:roomId/replay?revision=:revision`
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
- `play_next_card`
- `collect_pile`
- `give_cards`
- `reveal_cards`
- `shuffle_pile`
- `announce`
- `react`
- `end_turn`
- `finish_table` (host only; confirmation-gated)

Tool schemas and results remain bounded. `inspect_table` is read-only. Mutations use accurate read-only/destructive annotations where supported. `finish_table` is destructive and waits for the same human confirmation as the direct host control. Once finished, only `inspect_table` remains registered. Any result containing the game brief or announcements carries `untrustedContentHint`.

## Security and privacy

- Separate room-and-seat-scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookies authenticate seats.
- Each tab stores only a non-secret seat selector in `sessionStorage`. HTTP sends it in `X-Card-Table-Seat`; WebSockets send it as the non-secret `seat` query value. The server selects and verifies the matching seat cookie.
- Session and invite values are stored only as hashes.
- Invite tokens are never placed in query strings or server logs.
- Logs contain request metadata only—never bodies, prompts, announcements, cards, cookies, or tokens.
- Opponent card IDs and faces never appear in another seat's HTTP, WebSocket, DOM, or WebMCP projection.
- Player-authored text does not influence authorization, tool registration, reducer rules, network destinations, or secret access.

## Verification and delivery

- Unit-test contracts, prompt/message bounds, card conservation, authorization, revisions, idempotency, ownership, visibility, hidden ordered zones, next-card play, pile collection, turns, shuffling, and preset validity.
- Integration-test creation, one-use invitations, two seats sharing one cookie jar, stale and duplicate actions, WebSocket snapshots/updates, hibernation attachments, expiry, host-only completion, and live plus replay per-seat projections.
- Test lobby approval, cancellation forwarding, contract-filtered tool registration, structured results, and UI/tool parity.
- Browser-test preset selection, visible drafting, approval/decline, creation, invite copy, two Codex tabs sharing cookies, announcement UI, hidden deck rendering, next-card play, pile collection, actual WebMCP registry contents, refresh recovery, responsive layout, and accessibility.
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
