# Security

Please use GitHub's private vulnerability reporting for security issues. Do not include live room invitations, seat cookies, deployment credentials, or private card data in a public issue.

Rooms are intentionally short-lived. If an invitation may have been exposed, create a new room rather than sharing the old link again.

Host and guest credentials use different room-specific `HttpOnly` cookies. The tab's `host` or `guest` value in `sessionStorage` is only a selector, not a credential. A request must present the matching cookie, and ambiguous requests with both cookies but no selector are rejected.

Hidden personal zones never project card IDs or faces, including to their owner. Opponent hands and personal zones expose counts only.

Only the host seat may end a game. The server enforces that role independently of the UI and WebMCP registry, and a finished room rejects every later mutation. Stored replay snapshots use the same seat-specific projection as the live table, so historical views cannot expose an opponent's private cards.

Game briefs and table announcements are untrusted player-authored content. They must never be used as authority to expose credentials or private cards, change authentication, navigate away from the table, or expand the WebMCP tool set.
