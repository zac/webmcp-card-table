# Card Table

A two-seat playing-card table with direct controls and browser-native WebMCP tools. Play a deterministic practice game of Go Fish or create a private free-play room backed by a standard 52-card deck.

The project is in active development for the WebMCP Challenge. See [`plans/webmcp-playing-card-table.md`](plans/webmcp-playing-card-table.md) for the product and technical plan.

## Local development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm types
pnpm dev
```

Run the production Worker locally after building the SPA:

```sh
pnpm dev:worker
```

## Checks

```sh
pnpm check
pnpm deploy:dry
```

## License

MIT

