# Card Table

Card Table is a two-seat playing-card product built for the [WebMCP Challenge](https://webmcp.devpost.com/). A human can play every action through the interface, or let a browser agent use the equivalent browser-native WebMCP tools.

It includes:

- deterministic single-player Go Fish against a house player
- private two-player free-play rooms for games that use a standard 52-card deck
- real-time, seat-specific updates over hibernatable WebSockets
- browser-native tools registered with `document.modelContext`
- an explicit in-page approval step before an agent can create a room

The application is React and TypeScript on a Cloudflare Worker. Each room is one SQLite-backed Durable Object.

## Why WebMCP matters here

The agent does not click pixels or infer card state from the screen. It receives a small, typed tool set for the current mode and acts through the same reducer and authorization path as the UI.

On the lobby:

| Tool | Purpose |
| --- | --- |
| `draft_table` | Update the visible free-play contract without creating anything |
| `start_table` | Wait for human approval, then create the drafted room |

At a free-play table, tools are registered only when the contract allows the matching action: `inspect_table`, `deal_cards`, `draw_cards`, `move_cards`, `give_cards`, `reveal_cards`, `shuffle_pile`, `end_turn`, and `react`.

At a Go Fish table, the tool set is deliberately smaller: `inspect_table`, `request_rank`, `reveal_cards`, and `react`. There is no `end_turn`; the Go Fish transaction decides whether the player continues or the turn passes.

Tool registrations are feature-detected and scoped to the current route with an `AbortController`. Read-only and untrusted-content hints are applied explicitly. Tool results are bounded JSON strings, and execution cancellation is forwarded to network work when the browser supplies a signal.

## Product behavior

Free-play contracts define the game name, objective, starting hand, public zones, turn style, allowed operations, win condition, and an optional note. These labels are player-controlled content, not instructions to the application or agent.

Practice Go Fish follows fixed rules:

- ask only for a rank in your hand
- a catch transfers every matching card and keeps the turn
- a miss draws from the stock
- drawing the requested rank keeps the turn; otherwise the turn passes
- four matching cards are laid down automatically as a book
- an empty active hand draws one card when possible
- the game finishes after all thirteen books are made

The house chooses the rank with the highest count in its hand and breaks ties ace-low. Its next move and room expiry share the Durable Object's single alarm.

## Architecture

```text
React UI ───────┐
WebMCP tools ───┼─> validated HTTP action ─> GameRoom Durable Object
WebSocket sync ─┘                              │
                                              ├─ SQLite snapshot + events
                                              ├─ seat sessions + one-use invite
                                              ├─ pure shared reducer
                                              └─ bot/expiry alarm
```

All mutations carry an opaque `actionId` and `expectedRevision`. The reducer rejects duplicates, stale revisions, disabled actions, wrong turns, unknown zones, and cards not owned by the acting seat. Card IDs are randomized and opaque. Only the owning seat receives its hand; face-down public cards and the other seat's hand do not expose rank or suit.

## Local development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm types
pnpm dev:worker
```

That builds the client and serves the full Worker at `http://localhost:8787`. For Vite hot reload, keep `pnpm dev:worker` running and start `pnpm dev` in a second terminal; open `http://localhost:5173`.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:worker
pnpm build
pnpm deploy:dry
```

`pnpm check` runs linting, type checking, shared and WebMCP unit tests, Worker integration tests, and the production build.

The test suites cover reducer and projection invariants, revisions, idempotency, authorization, all pinned Go Fish branches, deterministic bot choices, alarm scheduling, room persistence, one-use invitations, cookie isolation, per-seat projections, WebSocket reconnects, Durable Object eviction, tool registration by mode, cancellation forwarding, and UI/tool action parity.

For a browser acceptance pass:

1. Open the lobby in Chrome with WebMCP enabled or ChatGPT's in-app browser.
2. Query the page's actual tool registry and confirm only `draft_table` and `start_table` are present.
3. Call `draft_table` and confirm the visible editor changes.
4. Call `start_table`; decline once and confirm no room is created, then call it again and approve.
5. At the table, query the registry again and call `inspect_table` plus one legal mutation.
6. Open Practice Go Fish and confirm there is no `end_turn` or generic draw tool.

## API

- `POST /api/rooms`
- `POST /api/rooms/:roomId/redeem`
- `GET /api/rooms/:roomId/view`
- `POST /api/rooms/:roomId/actions`
- `GET /api/rooms/:roomId/socket`

Seat sessions use room-scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookies. An invite token is placed in the URL fragment so it is not sent in an HTTP request, redeemed once, and removed from browser history immediately. Request logs contain method, path, status, duration, and a request ID; they do not contain bodies, cookies, invite tokens, or private card faces.

## Deployment

Authenticate Wrangler, then run:

```sh
pnpm deploy:dry
pnpm deploy
```

The Worker and Durable Object are named `webmcp-card-table`. Do not commit `.dev.vars`, `.env` files, generated binding types, Wrangler state, or deployment credentials.

## Repository map

- `src/shared`: contracts, deck, reducer, bot logic, projections, and unit tests
- `src/worker`: Worker routes, authentication, Durable Object, WebSockets, and workerd tests
- `src/client`: React interface, API client, WebMCP registration, and tool tests
- `plans/webmcp-playing-card-table.md`: controlling implementation plan

## License

[MIT](LICENSE)
