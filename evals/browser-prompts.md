# Browser acceptance prompts

These prompts are a small manual regression set for a browser agent with WebMCP enabled.

## Lobby

1. Inspect the available tools. Draft a manual-turn table called “Agent Rummy” with seven starting cards, a stock and discard pile, and all free-play actions. Do not create it yet.
2. Start the drafted table and wait for my decision.
3. After I decline, confirm that no room was created.
4. Start it again and wait for approval.

## Free play

1. Inspect the table and report only your own hand, public pile counts, and whose turn it is.
2. Deal one card to each seat from the stock, then inspect the table again.
3. Move one card from your hand face up to the discard pile.
4. React with “well played.”

## Practice Go Fish

1. Inspect your hand and request a rank you hold.
2. Continue making legal rank requests until the house gets a turn, then wait for its update.
3. Confirm that no pass, end-turn, generic draw, move, give, shuffle, or deal tool is available.
