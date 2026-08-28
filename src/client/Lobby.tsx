import { useEffect, useRef, useState } from "react";
import { DEFAULT_FREE_PLAY_CONTRACT, type ActionName, type GameContract } from "../shared";
import { createFreePlayRoom, createPracticeRoom, type CreatedRoom } from "./api";
import { activeModelContext, registerLobbyTools } from "./webmcp";

interface LobbyProps {
  onRoomCreated: (room: CreatedRoom) => void;
}

const ACTION_OPTIONS: { name: ActionName; label: string }[] = [
  { name: "deal", label: "Deal to both seats" },
  { name: "draw", label: "Draw" },
  { name: "move", label: "Play to piles" },
  { name: "give", label: "Give cards" },
  { name: "reveal", label: "Reveal cards" },
  { name: "shuffle", label: "Shuffle piles" },
  { name: "react", label: "Reactions" },
  { name: "end_turn", label: "End turn" },
];

export function Lobby({ onRoomCreated }: LobbyProps) {
  const [draft, setDraft] = useState<GameContract>(structuredClone(DEFAULT_FREE_PLAY_CONTRACT));
  const [showDraft, setShowDraft] = useState(false);
  const [busy, setBusy] = useState<"practice" | "free_play" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const draftRef = useRef(draft);
  const approvalRef = useRef<PendingApproval | null>(null);
  const approveButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { approvalRef.current = approval; }, [approval]);
  useEffect(() => { if (approval) approveButton.current?.focus(); }, [approval]);

  useEffect(() => {
    const context = activeModelContext();
    if (!context) return;
    const lifecycle = new AbortController();
    registerLobbyTools(context, {
      getDraft: () => draftRef.current,
      setDraft: (next) => { draftRef.current = next; setDraft(next); setShowDraft(true); },
      requestStart: (signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason ?? new DOMException("Tool execution cancelled", "AbortError"));
        if (approvalRef.current) return reject(new Error("Another table approval is already pending"));
        const pending: PendingApproval = { signal, resolve, reject };
        approvalRef.current = pending;
        setApproval(pending);
        signal.addEventListener("abort", () => {
          if (approvalRef.current !== pending) return;
          approvalRef.current = null;
          setApproval(null);
          reject(signal.reason ?? new DOMException("Tool execution cancelled", "AbortError"));
        }, { once: true });
      }),
    }, lifecycle.signal);
    return () => lifecycle.abort();
  }, []);

  async function startPractice() {
    setBusy("practice");
    setError(null);
    try {
      onRoomCreated(await createPracticeRoom());
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  }

  async function startFreePlay() {
    setBusy("free_play");
    setError(null);
    try {
      onRoomCreated(await createFreePlayRoom(draft));
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  }

  async function approveAgentStart() {
    const pending = approvalRef.current;
    if (!pending) return;
    setBusy("free_play");
    setError(null);
    try {
      const room = await createFreePlayRoom(draftRef.current, pending.signal);
      approvalRef.current = null;
      setApproval(null);
      pending.resolve({ roomId: room.roomId, inviteUrl: room.inviteUrl });
      window.setTimeout(() => onRoomCreated(room), 0);
    } catch (reason) {
      approvalRef.current = null;
      setApproval(null);
      pending.reject(reason);
      if (!pending.signal.aborted) setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  }

  function declineAgentStart() {
    const pending = approvalRef.current;
    if (!pending) return;
    approvalRef.current = null;
    setApproval(null);
    pending.reject(new Error("The human declined to create the table"));
  }

  return (
    <main className="lobby-shell">
      <SiteHeader />
      <section className="lobby-hero" aria-labelledby="lobby-title">
        <p className="eyebrow">Two seats. One honest deck.</p>
        <h1 id="lobby-title">A card table your agent can actually play.</h1>
        <p className="hero-copy">Coach a browser agent through Go Fish, or open a private table for any game you can play with a standard deck.</p>
        <div className="hero-actions">
          <button className="button button-primary" type="button" disabled={busy !== null} onClick={() => void startPractice()}>
            {busy === "practice" ? "Dealing…" : "Practice Go Fish"}
          </button>
          <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => setShowDraft((value) => !value)}>
            {showDraft ? "Close table draft" : "Draft a free-play table"}
          </button>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </section>

      {showDraft ? (
        <DraftEditor draft={draft} onChange={setDraft} onStart={() => void startFreePlay()} busy={busy === "free_play"} />
      ) : (
        <TablePreview />
      )}

      <footer className="lobby-footer">
        <p>Direct controls and WebMCP tools use the same rules.</p>
        <a href="https://github.com/zac/webmcp-card-table">Source</a>
      </footer>
      {approval && (
        <div className="approval-backdrop">
          <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
            <p className="eyebrow">Agent request</p>
            <h2 id="approval-title">Open this private table?</h2>
            <p id="approval-description">An agent prepared <strong>{draft.name}</strong> with {draft.startingHandSize} starting cards and {draft.allowedActions.length} allowed actions. Creating it will deal a new randomized deck.</p>
            <div className="approval-contract"><span>Objective</span><p>{draft.objective}</p><span>Win condition</span><p>{draft.winCondition}</p></div>
            <div className="approval-actions">
              <button className="button button-secondary" type="button" disabled={busy !== null} onClick={declineAgentStart}>Decline</button>
              <button ref={approveButton} className="button button-primary" type="button" disabled={busy !== null} onClick={() => void approveAgentStart()}>{busy === "free_play" ? "Opening…" : "Approve and open"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

interface PendingApproval {
  signal: AbortSignal;
  resolve: (room: { roomId: string; inviteUrl?: string }) => void;
  reject: (reason: unknown) => void;
}

export function SiteHeader({ onHome }: { onHome?: () => void }) {
  return (
    <header className="site-header">
      <button className="wordmark" type="button" onClick={onHome} aria-label="Card Table home">
        <span className="suit-mark" aria-hidden="true">♠</span>Card Table
      </button>
      <span className="status-chip">WebMCP ready</span>
    </header>
  );
}

function TablePreview() {
  return (
    <section className="table-preview" aria-label="Table preview">
      <div className="preview-seat preview-seat-away"><span className="seat-label">House</span><div className="card-stack" aria-hidden="true"><i /><i /><i /></div></div>
      <div className="dealer-rail"><span>Practice table</span><strong>Your turn</strong><span>7 cards each</span></div>
      <div className="preview-seat preview-seat-home"><span className="seat-label">You</span><div className="card-fan" aria-hidden="true"><i /><i /><i /><i /><i /></div></div>
    </section>
  );
}

function DraftEditor({ draft, onChange, onStart, busy }: { draft: GameContract; onChange: (draft: GameContract) => void; onStart: () => void; busy: boolean }) {
  const update = <K extends keyof GameContract>(key: K, value: GameContract[K]) => onChange({ ...draft, [key]: value });
  const discardEnabled = draft.zones.some((zone) => zone.id === "discard");

  function toggleAction(action: ActionName) {
    const enabled = draft.allowedActions.includes(action);
    update("allowedActions", enabled ? draft.allowedActions.filter((item) => item !== action) : [...draft.allowedActions, action]);
  }

  return (
    <section className="draft-panel" aria-labelledby="draft-title">
      <div className="draft-heading">
        <div><p className="eyebrow">Table contract</p><h2 id="draft-title">Set the boundaries</h2></div>
        <div className="contract-ticket"><span>Seats</span><strong>2 fixed</strong></div>
      </div>
      <div className="draft-grid">
        <label>Game name<input value={draft.name} maxLength={80} onChange={(event) => update("name", event.target.value)} /></label>
        <label>Objective<input value={draft.objective} maxLength={280} onChange={(event) => update("objective", event.target.value)} /></label>
        <label>Starting hand<input type="number" min={0} max={13} value={draft.startingHandSize} onChange={(event) => update("startingHandSize", Number(event.target.value))} /></label>
        <label>Turns<select value={draft.turnOrder} onChange={(event) => update("turnOrder", event.target.value as GameContract["turnOrder"])}><option value="alternating">Alternating</option><option value="manual">Manual</option></select></label>
        <label className="wide-field">Win condition<input value={draft.winCondition} maxLength={280} onChange={(event) => update("winCondition", event.target.value)} /></label>
        <label className="wide-field">Optional note<textarea value={draft.note ?? ""} maxLength={280} onChange={(event) => update("note", event.target.value)} /></label>
      </div>
      <fieldset className="choice-fieldset"><legend>Public zones</legend><label className="check-choice"><input type="checkbox" checked disabled /> Face-down stock</label><label className="check-choice"><input type="checkbox" checked={discardEnabled} onChange={(event) => update("zones", event.target.checked ? [...draft.zones, { id: "discard", kind: "discard", facing: "up" }] : draft.zones.filter((zone) => zone.id !== "discard"))} /> Face-up discard</label></fieldset>
      <fieldset className="choice-fieldset"><legend>Allowed actions</legend><div className="choice-row">{ACTION_OPTIONS.map((action) => <label className="check-choice" key={action.name}><input type="checkbox" checked={draft.allowedActions.includes(action.name)} onChange={() => toggleAction(action.name)} /> {action.label}</label>)}</div></fieldset>
      <div className="draft-summary"><div><span>Current draft</span><strong>{draft.name || "Untitled table"}</strong><small>{draft.startingHandSize} cards · {draft.turnOrder} turns · {draft.allowedActions.length} actions</small></div><button className="button button-primary" type="button" disabled={busy || draft.allowedActions.length === 0} onClick={onStart}>{busy ? "Opening…" : "Open private table"}</button></div>
    </section>
  );
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The table could not be opened";
}
