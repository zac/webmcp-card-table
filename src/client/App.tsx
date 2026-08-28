export function App() {
  return (
    <main className="lobby-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Card Table home">
          <span className="suit-mark" aria-hidden="true">♠</span>
          Card Table
        </a>
        <span className="status-chip">WebMCP ready</span>
      </header>

      <section className="lobby-hero" aria-labelledby="lobby-title">
        <p className="eyebrow">Two seats. One honest deck.</p>
        <h1 id="lobby-title">A card table your agent can actually play.</h1>
        <p className="hero-copy">
          Coach a browser agent through Go Fish, or open a private table for any game you can play with a standard deck.
        </p>
        <div className="hero-actions">
          <button className="button button-primary" type="button">Practice Go Fish</button>
          <button className="button button-secondary" type="button">Draft a free-play table</button>
        </div>
      </section>

      <section className="table-preview" aria-label="Table preview">
        <div className="preview-seat preview-seat-away">
          <span className="seat-label">House</span>
          <div className="card-stack" aria-hidden="true"><i /><i /><i /></div>
        </div>
        <div className="dealer-rail">
          <span>Practice table</span>
          <strong>Your turn</strong>
          <span>7 cards each</span>
        </div>
        <div className="preview-seat preview-seat-home">
          <span className="seat-label">You</span>
          <div className="card-fan" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        </div>
      </section>

      <footer className="lobby-footer">
        <p>Direct controls and WebMCP tools use the same rules.</p>
        <a href="https://github.com/zac/webmcp-card-table">Source</a>
      </footer>
    </main>
  );
}

