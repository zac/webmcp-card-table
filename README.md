# Card Table

Card Table is a prompt-defined, two-seat playing-card table built for the [WebMCP Challenge](https://webmcp.devpost.com/). Describe a game that uses a standard 52-card deck, open a private room, and either play through the interface or let ChatGPT or Codex use equivalent browser-native WebMCP tools.

[Open the live table](https://webmcp-card-table.zacwhite.workers.dev/) · [Browse the source](https://github.com/zac/webmcp-card-table)

The product has one shape:

1. Pick Go Fish, Crazy Eights, War, or Open Table as a starting point.
2. Edit the plain-language game brief and optional table mechanics.
3. Open the table and copy a one-use guest invite, a ready-made guest Codex prompt, or a prompt for Codex to play your own seat. The host sees when the invite is claimed and whether the guest is online.
4. Play by clicking cards and piles, through WebMCP tools, or both. Every action uses the same reducer and server authorization path.
5. When play is over, the host confirms **End game**. The room freezes for both seats and becomes a read-only revision replay instead of disappearing.

Presets are not hard-coded game modes. They only prefill a normal table contract. Card Table enforces ownership, privacy, revisions, zones, and optional alternating turns; the two players referee the game described in their brief.

Direct controls stay on the felt. Clicking stock offers draw, deal, and shuffle when the contract allows them. Selecting hand cards and clicking a shared pile offers valid play actions. Ordered personal piles expose next-card play, collection, and shuffle in place. The side panel is reserved for turn state, the game brief, announcements, reactions, and history.

## Why WebMCP matters here

A browser agent does not need to click pixels or infer card state from a screenshot. It receives a small, typed set of product operations and a private view of its own seat.

The lobby registers:

| Tool | Purpose |
| --- | --- |
| `draft_table` | Pick a preset or update the visible game name, brief, hand size, turns, zones, and actions |
| `start_table` | Wait for an explicit in-page human approval, then create the room |

At a table, tools are registered only when the contract allows the matching action:

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
- `finish_table` (host only; waits for in-page confirmation)

`play_next_card` moves the next card from an ordered personal pile without revealing it first. `collect_pile` moves a shared pile to the top or bottom of an ordered personal pile. Together they let the ordinary War preset use face-down decks without adding a War-specific game engine. War intentionally does not register `end_turn`: either seat can act, and the visible battle pile communicates the phase.

`announce` is a bounded 160-character public game channel. It lets players make requests and declarations such as "Do you have any queens?" or "Eights are hearts" without adding a general-purpose chat product.

Registrations feature-detect `document.modelContext` and are scoped to the active route with an `AbortController`. Results are bounded JSON. Tool execution forwards cancellation to the network request. The game brief and announcements are always labeled as untrusted player-authored content.

After the host ends a game, the registry contracts to `inspect_table`. Both seats can scrub the recorded table revisions, but replay controls cannot mutate historical or final state.

## Product and security behavior

A `GameContract` contains a name, a game prompt of at most 2,000 characters, a 0–26 card opening deal, its destination, manual or alternating turns, zones, and an allow-list of operations. Exactly one shared stock is required. Zones can be shared or instantiated once per seat. Seat zones can be owner-visible or hidden from everyone, and ordered zones support next-card play and top or bottom collection.

All mutations carry an opaque `actionId` and `expectedRevision`. The pure reducer rejects duplicates, stale revisions, disabled actions, wrong turns, unknown zones, and card IDs not owned by the acting seat.

Every card receives a cryptographically randomized opaque ID. Only the owning seat receives its visible hand or owner-visible zone faces. Opponent cards expose counts only. A hidden personal deck exposes neither faces nor card IDs to its owner. Face-down shared cards expose an ID and face state, never rank or suit.

Ending a game is a server-authorized host action. It changes the room to a terminal `finished` state, clears the active turn, rejects later mutations, and retains up to 250 revision snapshots plus the opening state. Replay snapshots are projected for the requesting seat at read time, so replay never widens card visibility.

Seat sessions use separate room-and-seat-scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookies. A tab keeps only its non-secret `host` or `guest` selector in `sessionStorage`, then sends that selector with HTTP and WebSocket requests. This lets two Codex threads share one browser cookie jar without replacing each other's credentials. The server still requires the matching seat cookie.

Guest invite tokens live in URL fragments, are redeemed once, and are removed from the address bar before the browser makes a room request. Redemption records a `seat_joined` revision and immediately broadcasts it to the host. Hibernatable socket presence then distinguishes waiting, joined-online, and joined-offline without persisting browser connection details. Request logs never include bodies, cookies, invite tokens, prompts, announcements, or card faces.

## Architecture

```text
React controls ──┐
WebMCP tools ────┼──> validated HTTP action ──> GameRoom Durable Object
WebSocket sync ──┘                                  │
                                                    ├─ SQLite snapshot + revision replay
                                                    ├─ seat sessions + one-use invite
                                                    ├─ pure shared reducer
                                                    └─ 24-hour expiry alarm
```

Each room maps to one SQLite-backed Durable Object. State is persisted before a projected update is broadcast over hibernatable WebSockets. A reconnecting client sends its last revision and receives a seat-specific snapshot when stale.

## Local development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm types
pnpm dev:worker
```

The full Worker runs at `http://localhost:8787`.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:worker
pnpm build
pnpm deploy:dry
```

`pnpm check` runs linting, type checking, shared and WebMCP unit tests, Worker integration tests, and the production build. The suites cover reducer invariants, prompt and message bounds, authorization, revisions, idempotency, hidden ordered zones, next-card play, pile collection, visibility projections, shuffled-card identity, room persistence, one-use invites, join events, online/offline presence, two-seat shared-cookie isolation, WebSocket resynchronization, hibernation, expiry, host-only game completion, seat-projected replay, tool registration, approval, and cancellation forwarding.

For a browser acceptance pass:

1. Open the lobby in ChatGPT's in-app browser or Chrome with WebMCP enabled.
2. Query the browser's actual WebMCP registry and confirm `draft_table` and `start_table` are present.
3. Draft a preset or custom game and confirm the visible rules slip changes.
4. Call `start_table`; decline once, then call it again and approve.
5. Confirm the table registry matches the contract, call `inspect_table`, and make one legal mutation.
6. Copy the guest Codex prompt, redeem the invitation in a second Codex thread that shares browser storage, and confirm the host changes from Waiting for guest to Guest joined · online before the guest plays a card.
7. For War, confirm both decks show counts and backs only, `end_turn` is absent, then call `play_next_card` from each seat and `collect_pile` from the winner.
8. Refresh both seats and confirm they recover the current projected snapshot.
9. As the guest, confirm `finish_table` and the End game control are absent. As the host, call `finish_table`, decline once, then approve it.
10. Confirm both seats freeze, only `inspect_table` remains registered, and the replay transport can move between recorded revisions without revealing the other seat's cards.

## API

- `POST /api/rooms` with `{ contract }`
- `POST /api/rooms/:roomId/redeem`
- `GET /api/rooms/:roomId/view`
- `GET /api/rooms/:roomId/replay?revision=:revision`
- `POST /api/rooms/:roomId/actions`
- `GET /api/rooms/:roomId/socket`

## Deployment

```sh
pnpm deploy:dry
pnpm deploy
```

The Worker and Durable Object use the internal name `webmcp-card-table`. The production build serves the React assets and Worker APIs from the same origin.

Cloudflare Workers Builds is configured for `zac/webmcp-card-table` with `main` as the production branch, `pnpm check` as the build command, and Wrangler as the deploy command. Preview-branch builds are disabled. The Git account connection must remain active in the Worker settings; if Cloudflare reports it disconnected, pushes will not trigger builds and the project must be reconnected before relying on continuous deployment.

## Repository map

- `src/shared`: contracts, presets, deck, reducer, projections, and unit tests
- `src/worker`: routes, authentication, Durable Object, WebSockets, and workerd tests
- `src/client`: React interface, API client, WebMCP registration, and tool tests
- `evals/browser-prompts.md`: manual WebMCP acceptance prompts
- `plans/webmcp-playing-card-table.md`: revised product and implementation plan

## License

[MIT](LICENSE)
