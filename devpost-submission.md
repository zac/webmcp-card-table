# Title

Card Table

## One-line Summary

A live, prompt-defined card table where people and browser agents play the same two-seat games through direct controls or WebMCP tools.

## Problem

A browser agent trying to join a live card game usually has two bad options. It can click through a visual interface and guess what each card, pile, and turn indicator means, or it can use a separate integration that the human player cannot see or control.

Card games make those weaknesses obvious. The app has private information, actions arrive in real time, and a legal move depends on the current table state. A useful agent needs structured access to its own cards and the available actions, but it must not see the other player's hand. The human also needs to understand what the agent is doing and be able to act through the ordinary interface at any time.

## Solution

Card Table is a live, two-player table for games played with a standard 52-card deck. A host picks a preset such as War, Crazy Eights, or Go Fish, or writes a game brief in plain language. The host then opens a private room and shares a one-use invite or a ready-made Codex prompt with the other seat.

Each player can act through the table interface, ask Codex to act for them, or let an agent play its seat. The page registers WebMCP tools that match the current table contract. A War table exposes operations such as `inspect_table`, `play_next_card`, `collect_pile`, `announce`, and `react`. A different contract gets a different tool set.

The interface and WebMCP tools use the same server action path. The server enforces card ownership, private views, available operations, revision checks, optional turns, and zone rules. The game brief remains free-form, so people and agents can play many games without a separate rules engine for each one.

## Why This Matters

Card Table treats an agent as a participant in a shared product, not as a script running beside it. A person can create the room, approve an agent-prepared table, invite another person or agent, watch every move arrive in real time, and take over through the interface whenever they want.

WebMCP makes that possible without screen scraping. The agent receives named operations, bounded schemas, and a seat-specific view of the table. The human sees those same operations happen on the felt. Private cards stay private, even when both seats use agents in the same browser cookie jar.

The card game is intentionally playful, but the pattern applies to any live collaborative app with private roles, shared state, and human oversight.

## How We Used AI

Card Table does not embed a model or call an AI API. Instead, it gives browser agents a reliable way to participate in the product through WebMCP.

An agent reads the human-written game brief and the structured state returned by `inspect_table`. It decides which registered tool to call, such as playing the next card, collecting a pile, announcing a choice, or reacting to the other player. The server validates the requested action and returns a bounded result. The model handles judgment and game strategy; the application handles authority, privacy, identity, and consistency.

This split lets a user choose how much control to hand over. They can tell Codex each move, ask it for advice, or let it play until the table needs human input. The same room can contain two people, one person and one agent, or two agents supervised by people.

## How We Used Codex

Codex helped plan, implement, test, deploy, and then play the product. The build started from a written implementation plan and landed as a sequence of small commits covering the shared reducer, Durable Object persistence, WebSocket updates, UI, WebMCP registration, and deployment.

The most useful work happened after the first deployment. Two Codex threads joined the same War room and played through the page's WebMCP tools. That smoke test exposed problems that static tests did not:

- The two threads shared browser cookies, so a single room cookie could not safely identify both seats. The app now uses room-and-seat-scoped cookies plus a non-secret per-tab seat selector.
- Hidden ordered decks looked like enormous hands. The generic zone model now distinguishes hands, ordered decks, player-owned public slots, and face-down war piles.
- The host could not tell whether the guest had redeemed the invite or was online. Invite redemption now records a revision, and hibernatable WebSockets report live presence.
- A large action sidebar made the table hard to use. Actions now appear in context when a player clicks a card or pile.
- Early card transitions substituted a fading visual for the real card. The current motion system measures the source and destination, moves the rendered card itself, flips it in flight when needed, and accounts for whether the card lands above or below the destination pile.

Codex also wrote and ran reducer tests, Worker integration tests, WebMCP lifecycle tests, and browser acceptance prompts. On August 30, the full `pnpm check` command passed with 28 unit tests and 13 Worker tests, along with linting, type checking, and a production build.

## Key Features

- Prompt-defined two-player games using a standard 52-card deck.
- Presets for War, Crazy Eights, Go Fish, and an open table. Presets only prefill the same editable contract used by custom games.
- Browser-native WebMCP tools registered through `document.modelContext.registerTool` and scoped to the current route with an `AbortController`.
- Human approval before the `start_table` tool can create a room.
- Contract-specific tools, schemas, and action hints. Tools disappear when the contract or finished state no longer allows them.
- Direct UI controls and WebMCP tools backed by the same reducer and authorization path.
- Seat-specific projections that never expose the opponent's private card faces.
- One-use invitation tokens stored in URL fragments and cleared before room requests.
- Room-and-seat-scoped secure cookies that allow two Codex threads to use different seats in one shared cookie jar.
- Real-time projected updates and presence over hibernatable WebSockets.
- Contextual card and pile controls, responsive table layouts, and reduced-motion support.
- Host-confirmed game completion followed by read-only revision replay.

## Architecture

The frontend uses React, TypeScript, and Vite. A Cloudflare Worker serves the application and API from one origin. Each room maps to a SQLite-backed Durable Object that owns the authoritative state, seat sessions, invitation redemption, event history, replay snapshots, WebSockets, and the 24-hour expiry alarm.

```text
React controls ──┐
WebMCP tools ────┼──> validated HTTP action ──> GameRoom Durable Object
WebSocket sync ──┘                                  │
                                                    ├─ SQLite state and revision replay
                                                    ├─ seat sessions and one-use invite
                                                    ├─ pure shared reducer
                                                    └─ hibernatable WebSockets
```

Every mutation contains an opaque `actionId` and `expectedRevision`. The shared reducer rejects duplicate actions, stale revisions, disabled operations, wrong turns, unknown zones, and card IDs the actor does not own. The Durable Object persists the new state before it broadcasts a seat-specific update.

Cards use cryptographically randomized opaque IDs. A projection layer decides whether each seat may receive a card ID, face state, rank, or suit. Player-authored game briefs and table messages stay labeled as untrusted content in WebMCP results.

## Testing Instructions

No account or credentials are required.

1. Open [Card Table](https://webmcp-card-table.zacwhite.workers.dev/) in ChatGPT's in-app browser or in Chrome with WebMCP enabled.
2. Wait for the page to show `WebMCP ready`.
3. Fetch the page's WebMCP tools. Confirm that the lobby exposes `draft_table` and `start_table`.
4. Call `draft_table` with the War preset. Confirm that the visible game name, brief, zones, and allowed actions update.
5. Call `start_table`. The tool should pause for an in-page approval dialog. Decline once to verify cancellation, then call it again and approve.
6. On the new table, call `inspect_table`. Confirm that your ordered deck exposes a count but no card faces or card IDs.
7. Copy the guest Codex prompt or the one-use invite. Open it in a second Codex thread or browser tab. Confirm the host changes from waiting to `Guest joined · online`.
8. From each seat, call `play_next_card` to move the next hidden deck card to that player's face-up battle slot. Confirm that the UI animates both tool-driven moves.
9. Have the higher card's owner call `collect_pile` for both battle slots, placing the cards at the bottom of their deck.
10. Make one move through the direct table controls and confirm that both seats receive the same real-time update.
11. As the host, call `finish_table`. Decline once, then approve. Confirm that the room freezes, only `inspect_table` remains, and the revision replay does not reveal the other seat's private cards.

Local verification:

```sh
pnpm install
pnpm check
pnpm deploy:dry
```

## Public Demo Link

https://webmcp-card-table.zacwhite.workers.dev/

Verified HTTP 200 on August 30, 2026.

## Public Repository Link

https://github.com/zac/webmcp-card-table

GitHub reports the repository as public and detects its MIT license.

## Demo Video

Public YouTube URL: **TODO**

Planned length: about 2 minutes 30 seconds.

### Video outline

- **0:00 to 0:15:** Cold open on an active War table. One Codex seat plays a card through WebMCP, the other answers, and the winning agent collects the battle.
- **0:15 to 0:35:** Return to the lobby. Show `draft_table` preparing War and `start_table` waiting for human approval.
- **0:35 to 0:55:** Approve the room, copy the guest Codex prompt, and show the second seat join. Point out the live presence state.
- **0:55 to 1:35:** Show `inspect_table`, private deck projection, `play_next_card`, card movement, a tie using the per-player war piles, and `collect_pile`.
- **1:35 to 1:55:** Make a move through the direct UI. Explain that UI and agent actions use the same reducer and server authorization path.
- **1:55 to 2:15:** Briefly show the route-specific tool registry and explain that the finished table contracts to `inspect_table` only.
- **2:15 to 2:30:** End the game, scrub the revision replay, and close on the live URL and public repository.

The narration should state clearly that Card Table does not call a model API. WebMCP lets the browser's agent understand and operate the live product through typed tools.

## Screenshot Shot List

1. **Lobby and game brief:** Desktop view with War selected, the editable rules slip visible, and `WebMCP ready` in frame.
2. **Human approval:** The `start_table` approval dialog showing that an agent cannot create a room without the person approving it.
3. **Two live seats:** Active War table with `Guest joined · online`, both ordered decks, both battle slots, and both war piles visible.
4. **Agent operation:** Codex beside the table after calling `inspect_table` or `play_next_card`, with the corresponding card visible on the felt.
5. **Finished replay:** Frozen table with the revision replay controls and the reduced `inspect_table`-only tool registry.

Capture at least one narrow mobile image for the repository, but use the clearest desktop images in Devpost.

## Submission Readiness Notes

- The project was created during the submission period. The first repository commit is dated August 27, 2026.
- The live app returned HTTP 200 on August 30, 2026.
- GitHub reports the repository as public and detects the MIT license.
- `pnpm check` passed on August 30 with linting, type checking, 28 unit tests, 13 Worker tests, and a production build. `pnpm deploy:dry` also passed and validated the Worker assets and Durable Object binding.
- Earlier live smoke tests used the Codex in-app browser and two Codex threads. Run one clean final registry and multiplayer pass against the current deployment before final review.
- An existing Devpost project record is present as an `Untitled` pre-draft. Update project ID `1405082`; do not create a second project.
- The public video and final screenshots are still missing.
- Confirm the title and summary before copying this draft into Devpost.

## Known Limitations

- Card Table enforces table mechanics, authority, privacy, and optional turns. Players and agents interpret and referee the game-specific rules in the plain-language brief.
- Rooms support exactly two seats and one standard 52-card deck.
- Rooms use private invitations rather than public matchmaking.
- Rooms expire after 24 hours.
- WebMCP requires ChatGPT's in-app browser or a compatible browser with WebMCP enabled. The direct UI remains usable without it.
- Revision replay retains the opening state and up to 250 later snapshots.

## TODO Official Form Fields

The official form was fetched on August 30, 2026. It does not ask for a Codex session ID.

- **28249, Submitter Type:** TODO confirm `Individual`.
- **28250, Country of residence:** TODO confirm `United States`.
- **28251, Organization name:** Leave blank unless entering for an organization.
- **28252, App Status:** `New`. The first commit was created during the submission period.
- **28253, Existing app changes:** Not applicable if App Status remains `New`.
- **28254, Live URL:** `https://webmcp-card-table.zacwhite.workers.dev/`
- **28255, Testing instructions:** Use the Testing Instructions section above. No credentials are required.
- **28256, Public code repository:** `https://github.com/zac/webmcp-card-table`
- **28257, Tested agents or clients:** `Codex in-app browser with browser-native WebMCP, including a two-thread multiplayer smoke test.` Add Chrome only after a separate Chrome pass.
- **28258, AI tools used:** `Codex for planning, implementation, tests, deployment, browser-based WebMCP playthroughs, and design iteration.`
- **28259, Learning level:** TODO confirm. Suggested answer: `Significant`.
- **28260, Career AI value:** TODO confirm. Suggested answer: `Yes`.
- **Required demo video:** TODO add the public YouTube URL.
