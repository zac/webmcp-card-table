import { useEffect, useRef, useState } from "react";
import {
  GAME_PRESETS,
  type ActionName,
  type GameContract,
  type GamePresetId,
} from "../shared";
import { createRoom, type CreatedRoom } from "./api";
import { activeModelContext, registerLobbyTools } from "./webmcp";

interface LobbyProps {
  onRoomCreated: (room: CreatedRoom) => void;
}

const ACTION_OPTIONS: { name: ActionName; label: string }[] = [
  { name: "deal", label: "Deal" },
  { name: "draw", label: "Draw" },
  { name: "move", label: "Play to piles" },
  { name: "play_next", label: "Play next card" },
  { name: "collect", label: "Collect piles" },
  { name: "give", label: "Give cards" },
  { name: "reveal", label: "Reveal" },
  { name: "shuffle", label: "Shuffle" },
  { name: "announce", label: "Table messages" },
  { name: "react", label: "Reactions" },
  { name: "end_turn", label: "Pass turn" },
];

const initialPreset = GAME_PRESETS.find((preset) => preset.id === "go_fish")!;

export function Lobby({ onRoomCreated }: LobbyProps) {
  const [draft, setDraft] = useState<GameContract>(() => structuredClone(initialPreset.contract));
  const [selectedPreset, setSelectedPreset] = useState<GamePresetId | null>(initialPreset.id);
  const [busy, setBusy] = useState(false);
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
      setDraft: (next) => {
        draftRef.current = next;
        setDraft(next);
        setSelectedPreset(null);
      },
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

  function choosePreset(presetId: GamePresetId) {
    const preset = GAME_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const next = structuredClone(preset.contract);
    draftRef.current = next;
    setDraft(next);
    setSelectedPreset(preset.id);
  }

  function updateDraft(next: GameContract) {
    draftRef.current = next;
    setDraft(next);
    setSelectedPreset(null);
  }

  async function startTable(signal?: AbortSignal): Promise<CreatedRoom> {
    setBusy(true);
    setError(null);
    try {
      return await createRoom(draftRef.current, signal);
    } catch (reason) {
      if (!signal?.aborted) setError(messageFor(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  async function startFromUi() {
    try {
      onRoomCreated(await startTable());
    } catch {
      // startTable renders the actionable error.
    }
  }

  async function approveAgentStart() {
    const pending = approvalRef.current;
    if (!pending) return;
    try {
      const room = await startTable(pending.signal);
      approvalRef.current = null;
      setApproval(null);
      pending.resolve({ roomId: room.roomId, inviteUrl: room.inviteUrl });
      window.setTimeout(() => onRoomCreated(room), 0);
    } catch (reason) {
      approvalRef.current = null;
      setApproval(null);
      pending.reject(reason);
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
      <section className="dealer-station" aria-labelledby="lobby-title">
        <div className="station-intro">
          <p className="eyebrow">A live card table for two</p>
          <h1 id="lobby-title">Name the game. Deal in your agent.</h1>
          <p className="hero-copy">Describe the game in plain language. Invite a second seat, then play by hand or through the page's WebMCP tools.</p>
          <div className="agent-demo" aria-hidden="true">
            <div className="demo-deck"><i /><i /><i /></div>
            <div className="demo-command"><span>play_next_card</span><i /></div>
            <div className="demo-card"><strong>Q</strong><span>♠</span></div>
          </div>
          <div className="table-proof" aria-label="Product capabilities">
            <span>Private hands</span><span>Live shared state</span><span>Browser-native tools</span>
          </div>
        </div>

        <section className="rules-slip" aria-labelledby="rules-title">
          <div className="slip-heading">
            <div><p className="eyebrow">New private table</p><h2 id="rules-title">Set the table</h2></div>
            <span className="slip-number">52 cards<br />2 seats</span>
          </div>

          <div className="preset-rack" aria-label="Suggested games">
            {GAME_PRESETS.map((preset) => (
              <button
                className={selectedPreset === preset.id ? "preset-card selected" : "preset-card"}
                key={preset.id}
                type="button"
                onClick={() => choosePreset(preset.id)}
                aria-pressed={selectedPreset === preset.id}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>

          <DraftEditor draft={draft} onChange={updateDraft} />
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="start-table-row">
            <p className="approval-note">Agents can draft the rules. You approve every new table.</p>
            <button className="button button-primary open-table-button" type="button" disabled={busy || !draft.name.trim() || !draft.gamePrompt.trim()} onClick={() => void startFromUi()}>
              {busy ? "Shuffling…" : "Open table and get invite"}
            </button>
          </div>
        </section>
      </section>

      <footer className="lobby-footer">
        <p>Direct controls and WebMCP tools share one reducer.</p>
        <a href="https://github.com/zac/webmcp-card-table">View source</a>
      </footer>

      {approval && (
        <div className="approval-backdrop">
          <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
            <p className="eyebrow">Agent request</p>
            <h2 id="approval-title">Open this private table?</h2>
            <p id="approval-description">An agent prepared <strong>{draft.name}</strong> with {draft.startingHandSize} cards per seat. Creating it shuffles a new deck and issues a one-use guest invite.</p>
            <div className="approval-contract"><span>Game brief</span><p>{draft.gamePrompt}</p></div>
            <div className="approval-actions">
              <button className="button button-secondary" type="button" disabled={busy} onClick={declineAgentStart}>Decline</button>
              <button ref={approveButton} className="button button-primary" type="button" disabled={busy} onClick={() => void approveAgentStart()}>{busy ? "Opening…" : "Approve and open"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

interface PendingApproval {
  signal: AbortSignal;
  resolve: (room: { roomId: string; inviteUrl: string }) => void;
  reject: (reason: unknown) => void;
}

export function SiteHeader({ onHome, status = "WebMCP ready" }: { onHome?: () => void; status?: string }) {
  return (
    <header className="site-header">
      <button className="wordmark" type="button" onClick={onHome} aria-label="Card Table home">
        <span className="suit-mark" aria-hidden="true">♠</span>Card Table
      </button>
      <span className={`status-chip${status === "WebMCP ready" ? "" : " pending"}`}><i aria-hidden="true" /> {status}</span>
    </header>
  );
}

function DraftEditor({ draft, onChange }: { draft: GameContract; onChange: (draft: GameContract) => void }) {
  const update = <K extends keyof GameContract>(key: K, value: GameContract[K]) => onChange({ ...draft, [key]: value });
  const discardEnabled = draft.zones.some((zone) => zone.id === "discard");
  const hiddenDeckEnabled = draft.zones.some((zone) => zone.id === "deck" && zone.scope === "seat");
  const seatZones = draft.zones.filter((zone) => zone.scope === "seat");

  function toggleAction(action: ActionName) {
    const enabled = draft.allowedActions.includes(action);
    update("allowedActions", enabled ? draft.allowedActions.filter((item) => item !== action) : [...draft.allowedActions, action]);
  }

  function toggleHiddenDeck(enabled: boolean) {
    if (enabled) {
      const zones = hiddenDeckEnabled
        ? draft.zones
        : [...draft.zones, { id: "deck", kind: "pile" as const, facing: "down" as const, scope: "seat" as const, visibility: "hidden" as const, ordered: true }];
      onChange({ ...draft, zones, startingZoneId: "deck" });
    } else {
      onChange({ ...draft, zones: draft.zones.filter((zone) => !(zone.id === "deck" && zone.scope === "seat")), startingZoneId: "hand" });
    }
  }

  return (
    <div className="draft-editor">
      <label>Game name<input value={draft.name} maxLength={80} onChange={(event) => update("name", event.target.value)} /></label>
      <label className="prompt-field">Game brief<textarea value={draft.gamePrompt} maxLength={2_000} rows={8} onChange={(event) => update("gamePrompt", event.target.value)} /><small>{draft.gamePrompt.length} / 2,000 · Shared with both seats as untrusted game content</small></label>
      <details className="advanced-settings">
        <summary>Fine-tune the table <span>{draft.startingHandSize} cards to {draft.startingZoneId} · {draft.turnOrder}</span></summary>
        <div className="advanced-grid">
          <label>Opening cards per seat<input type="number" min={0} max={26} value={draft.startingHandSize} onChange={(event) => update("startingHandSize", Number(event.target.value))} /></label>
          <label>Turn handling<select value={draft.turnOrder} onChange={(event) => update("turnOrder", event.target.value as GameContract["turnOrder"])}><option value="manual">Players manage turns</option><option value="alternating">Table enforces turns</option></select></label>
          <label>Opening cards<select value={draft.startingZoneId} onChange={(event) => update("startingZoneId", event.target.value)}><option value="hand">Visible hand</option>{seatZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.id.replaceAll("_", " ")} ({zone.visibility})</option>)}</select></label>
        </div>
        <details className="capability-settings">
          <summary>Zones and available moves <span>{draft.zones.length} zones · {draft.allowedActions.length} moves</span></summary>
          <fieldset className="choice-fieldset"><legend>Zones</legend><div className="choice-row"><label className="check-choice"><input type="checkbox" checked disabled /> Shared face-down stock</label><label className="check-choice"><input type="checkbox" checked={discardEnabled} onChange={(event) => update("zones", event.target.checked ? [...draft.zones, { id: "discard", kind: "discard", facing: "up", scope: "shared", visibility: "public", ordered: true }] : draft.zones.filter((zone) => zone.id !== "discard"))} /> Shared face-up discard</label><label className="check-choice"><input type="checkbox" checked={hiddenDeckEnabled} onChange={(event) => toggleHiddenDeck(event.target.checked)} /> Hidden ordered deck for each seat</label></div></fieldset>
          <fieldset className="choice-fieldset"><legend>Allowed moves</legend><div className="choice-row">{ACTION_OPTIONS.map((action) => <label className="check-choice" key={action.name}><input type="checkbox" checked={draft.allowedActions.includes(action.name)} onChange={() => toggleAction(action.name)} /> {action.label}</label>)}</div></fieldset>
        </details>
      </details>
    </div>
  );
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The table could not be opened";
}
