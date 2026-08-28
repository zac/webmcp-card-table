import { useCallback, useEffect, useRef, useState } from "react";
import type { Reaction, Rank, TableAction, TableEvent, TableView } from "../shared";
import { RANKS } from "../shared";
import { ApiError, fetchTable, redeemInvite, submitTableAction } from "./api";
import { PlayingCard } from "./Card";
import { SiteHeader } from "./Lobby";

interface TablePageProps {
  roomId: string;
  initialView?: TableView;
  inviteUrl?: string;
  onHome: () => void;
}

const REACTION_BUTTONS: { value: Reaction; label: string }[] = [
  { value: "well_played", label: "Well played" },
  { value: "thinking", label: "Thinking" },
  { value: "ouch", label: "Ouch" },
  { value: "gg", label: "Good game" },
];

export function TablePage({ roomId, initialView, inviteUrl, onHome }: TablePageProps) {
  const [view, setView] = useState<TableView | null>(initialView ?? null);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedCards, setSelectedCards] = useState<string[]>([]);
  const [knownInviteUrl] = useState(inviteUrl);
  const loaded = useRef(false);
  const revision = useRef(initialView?.revision ?? 0);

  useEffect(() => {
    revision.current = view?.revision ?? revision.current;
  }, [view]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const controller = new AbortController();
    const hash = window.location.hash;
    const inviteToken = hash.startsWith("#invite=") ? hash.slice("#invite=".length) : null;
    if (inviteToken) window.history.replaceState(window.history.state, "", `/table/${roomId}`);

    async function load() {
      try {
        const nextView = inviteToken
          ? (await redeemInvite(roomId, inviteToken, controller.signal)).view
          : initialView ?? (await fetchTable(roomId, controller.signal));
        setView(nextView);
        revision.current = nextView.revision;
      } catch (reason) {
        if (!controller.signal.aborted) setError(messageFor(reason));
      }
    }
    void load();
    return () => controller.abort();
  }, [initialView, roomId]);

  useEffect(() => {
    if (!view) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/rooms/${roomId}/socket`);
      socket.addEventListener("open", () => {
        setConnection("live");
        socket?.send(JSON.stringify({ type: "hello", lastRevision: revision.current }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; view?: TableView; revision?: number };
          if ((message.type === "snapshot" || message.type === "update") && message.view) {
            revision.current = message.view.revision;
            setView(message.view);
          }
        } catch {
          setError("The live update could not be read. Refresh to resync the table.");
        }
      });
      socket.addEventListener("close", (event) => {
        setConnection("offline");
        if (!disposed && event.code !== 4001) reconnectTimer = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => setConnection("offline"));
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socket?.close(1000, "route changed");
    };
  }, [roomId, Boolean(view)]);

  const act = useCallback(async (action: TableAction) => {
    if (!view || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await submitTableAction(roomId, {
        actionId: crypto.randomUUID(),
        expectedRevision: view.revision,
        action,
      });
      revision.current = next.revision;
      setView(next);
      setSelectedCards([]);
    } catch (reason) {
      setError(messageFor(reason));
      if (reason instanceof ApiError && reason.code === "stale_revision") {
        const fresh = await fetchTable(roomId);
        setView(fresh);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, roomId, view]);

  if (!view) {
    return <main className="table-shell"><SiteHeader onHome={onHome} /><section className="loading-table"><div className="deck-loader" /><h1>Finding your seat…</h1>{error && <p className="inline-error" role="alert">{error}</p>}</section></main>;
  }

  const ownTurn = view.contract.turnOrder === "manual" || view.activeSeatId === view.self.seatId;
  const heldRanks = new Set(view.self.hand.map((card) => card.rank));
  const toggleCard = (cardId: string) => setSelectedCards((current) => current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]);

  return (
    <main className="table-shell">
      <SiteHeader onHome={onHome} />
      <section className="table-topbar">
        <div><p className="eyebrow">{view.contract.kind === "go_fish" ? "Practice match" : "Private table"}</p><h1>{view.contract.name}</h1></div>
        <div className="table-meta"><span className={`connection-dot ${connection}`} />{connection}<span>Round {view.revision}</span>{knownInviteUrl && <CopyInvite inviteUrl={knownInviteUrl} />}</div>
      </section>

      <section className="game-layout">
        <div className="game-surface">
          <SeatArea label={view.opponent.seatId === "house" ? "House" : "Across the table"} count={view.opponent.cardCount} bookCount={view.opponent.bookCount} away />
          <div className="live-dealer-rail"><span>{view.publicZones.find((zone) => zone.kind === "stock")?.cardCount ?? 0} in stock</span><strong>{turnLabel(view)}</strong><span>{view.self.books?.length ?? 0}–{view.opponent.bookCount ?? 0} books</span></div>
          <div className="public-zones">
            {view.publicZones.map((zone) => <div className="public-zone" key={zone.zoneId}><span>{zone.zoneId}</span>{zone.cards.length ? <PlayingCard card={zone.cards.at(-1)} compact /> : <div className="empty-card-slot" /> }<small>{zone.cardCount} cards</small></div>)}
          </div>
          <div className="self-seat">
            {view.self.books && view.self.books.length > 0 && <div className="books-row" aria-label="Your books">{view.self.books.map((book) => <div className="book" key={book[0].rank}><PlayingCard card={book[0]} compact /><span>Book</span></div>)}</div>}
            <div className="hand" aria-label="Your hand">{view.self.hand.map((card) => <PlayingCard key={card.id} card={card} selected={selectedCards.includes(card.id)} onClick={() => toggleCard(card.id)} />)}</div>
            <span className="seat-label">Your hand · {view.self.hand.length}</span>
          </div>
        </div>

        <aside className="control-rail">
          <div className="turn-card"><span>{ownTurn ? "Action open" : "Waiting"}</span><strong>{view.status === "finished" ? `${view.winnerSeatId === view.self.seatId ? "You win" : "Game over"}` : ownTurn ? "Your move" : `${view.activeSeatId} is playing`}</strong><p>{view.contract.objective}</p></div>
          {view.contract.kind === "go_fish" ? (
            <GoFishControls heldRanks={heldRanks} ownTurn={ownTurn} busy={busy} selectedCards={selectedCards} onAction={(action) => void act(action)} />
          ) : (
            <FreePlayControls view={view} selectedCards={selectedCards} ownTurn={ownTurn} busy={busy} onAction={(action) => void act(action)} />
          )}
          <ReactionControls enabled={view.contract.allowedActions.includes("react")} busy={busy || !ownTurn} onAction={(action) => void act(action)} />
          {error && <p className="inline-error compact-error" role="alert">{error}</p>}
          <EventLog events={view.recentEvents} />
        </aside>
      </section>
    </main>
  );
}

function GoFishControls({ heldRanks, ownTurn, busy, selectedCards, onAction }: { heldRanks: Set<Rank>; ownTurn: boolean; busy: boolean; selectedCards: string[]; onAction: (action: TableAction) => void }) {
  return <section className="action-section"><h2>Ask for a rank</h2><div className="rank-grid">{RANKS.map((rank) => <button type="button" key={rank} disabled={!ownTurn || busy || !heldRanks.has(rank)} onClick={() => onAction({ type: "request_rank", rank })}>{rank}</button>)}</div><button className="control-button" type="button" disabled={!ownTurn || busy || selectedCards.length === 0} onClick={() => onAction({ type: "reveal", cardIds: selectedCards })}>Reveal selected</button></section>;
}

function FreePlayControls({ view, selectedCards, ownTurn, busy, onAction }: { view: TableView; selectedCards: string[]; ownTurn: boolean; busy: boolean; onAction: (action: TableAction) => void }) {
  const [zoneId, setZoneId] = useState(view.publicZones[0]?.zoneId ?? "stock");
  const [count, setCount] = useState(1);
  const disabled = !ownTurn || busy;
  const allowed = new Set(view.contract.allowedActions);
  return <section className="action-section free-controls"><h2>Table actions</h2><label>Active pile<select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>{view.publicZones.map((zone) => <option key={zone.zoneId} value={zone.zoneId}>{zone.zoneId}</option>)}</select></label>{allowed.has("draw") && <div className="inline-control"><input aria-label="Draw count" type="number" min={1} max={13} value={count} onChange={(event) => setCount(Number(event.target.value))} /><button type="button" disabled={disabled} onClick={() => onAction({ type: "draw", zoneId, count })}>Draw</button></div>}{allowed.has("move") && <div className="split-buttons"><button type="button" disabled={disabled || selectedCards.length === 0} onClick={() => onAction({ type: "move", cardIds: selectedCards, zoneId, face: "up" })}>Play face up</button><button type="button" disabled={disabled || selectedCards.length === 0} onClick={() => onAction({ type: "move", cardIds: selectedCards, zoneId, face: "down" })}>Play face down</button></div>}{allowed.has("give") && <button className="control-button" type="button" disabled={disabled || selectedCards.length === 0} onClick={() => onAction({ type: "give", cardIds: selectedCards, targetSeatId: view.opponent.seatId })}>Give selected</button>}{allowed.has("reveal") && <button className="control-button" type="button" disabled={disabled || selectedCards.length === 0} onClick={() => onAction({ type: "reveal", cardIds: selectedCards })}>Reveal selected</button>}{allowed.has("shuffle") && <button className="control-button" type="button" disabled={disabled} onClick={() => onAction({ type: "shuffle", zoneId })}>Shuffle pile</button>}{allowed.has("end_turn") && <button className="control-button end-turn" type="button" disabled={disabled} onClick={() => onAction({ type: "end_turn" })}>{view.contract.turnOrder === "manual" ? "Record a pass" : "End turn"}</button>}</section>;
}

function ReactionControls({ enabled, busy, onAction }: { enabled: boolean; busy: boolean; onAction: (action: TableAction) => void }) {
  if (!enabled) return null;
  return <section className="action-section reaction-section"><h2>React</h2><div className="reaction-row">{REACTION_BUTTONS.map((reaction) => <button type="button" key={reaction.value} disabled={busy} title={reaction.label} onClick={() => onAction({ type: "react", reaction: reaction.value })}>{reaction.label}</button>)}</div></section>;
}

function SeatArea({ label, count, bookCount, away }: { label: string; count: number; bookCount?: number; away?: boolean }) {
  return <div className={`opponent-seat${away ? " away" : ""}`}><span className="seat-label">{label} · {count} cards{bookCount !== undefined ? ` · ${bookCount} books` : ""}</span><div className="opponent-hand" aria-label={`${count} hidden cards`}>{Array.from({ length: Math.min(count, 10) }, (_, index) => <PlayingCard key={index} compact />)}</div></div>;
}

function EventLog({ events }: { events: TableEvent[] }) {
  return <section className="event-log"><h2>Table log</h2><ol>{[...events].reverse().slice(0, 12).map((event) => <li key={event.id}><span>R{event.revision}</span><p>{eventText(event)}</p></li>)}</ol></section>;
}

function CopyInvite({ inviteUrl }: { inviteUrl: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }
  return <button className="copy-invite" type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy invite"}</button>;
}

function turnLabel(view: TableView): string {
  if (view.status === "finished") return view.winnerSeatId === view.self.seatId ? "You won" : `${view.winnerSeatId} won`;
  if (view.contract.turnOrder === "manual") return "Open table";
  return view.activeSeatId === view.self.seatId ? "Your turn" : `${view.activeSeatId}'s turn`;
}

function eventText(event: TableEvent): string {
  const actor = event.actorSeatId === "human" || event.actorSeatId === "host" || event.actorSeatId === "guest" ? event.actorSeatId : event.actorSeatId ?? "Table";
  switch (event.type) {
    case "room_created": return "The deck was shuffled and dealt.";
    case "rank_requested": return `${actor} asked for ${String(event.data.rank)}s.`;
    case "go_fish": return event.data.matched ? `${actor} drew the requested rank and goes again.` : `${actor} went fishing.`;
    case "book_made": return `${actor} completed a book of ${String(event.data.rank)}s.`;
    case "cards_drawn": return `${actor} drew ${String(event.data.count)} card${event.data.count === 1 ? "" : "s"}.`;
    case "cards_moved": return `${actor} played cards to ${String(event.data.zoneId)}.`;
    case "cards_given": return `${actor} handed over ${String(event.data.count)} card${event.data.count === 1 ? "" : "s"}.`;
    case "cards_revealed": return `${actor} revealed selected cards.`;
    case "zone_shuffled": return `${actor} shuffled ${String(event.data.zoneId)}.`;
    case "reaction": return `${actor}: ${String(event.data.reaction).replaceAll("_", " ")}.`;
    case "turn_ended": return `${actor} passed the turn.`;
    case "card_drawn_for_empty_hand": return `${actor} drew for an empty hand.`;
    case "game_finished": return `${String(event.data.winnerSeatId)} won with ${String(event.data.books)} books.`;
  }
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The table could not complete that action";
}

