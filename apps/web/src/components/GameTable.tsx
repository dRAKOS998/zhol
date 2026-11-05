import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { RackEntry } from '@zhol/engine';
import type { DrawSource, PlayerView, ProtocolError, PublicSeat, PublicState } from '@zhol/protocol';
import { client, type ConnectionStatus } from '../lib/client';
import { errorText, formatScore, tileLabel } from '../lib/i18n';
import { FlightLayer, type FlightRequest, anchorRect, reducedMotion, tileBoxIn, useFlights } from './Flights';
import { Modal } from './Modal';
import { Rack } from './Rack';
import { Rules } from './Rules';
import { ScoreSummary, ScoreTable, winnersText } from './Scoreboard';
import { TileBack, TileFace } from './Tile';

type Position = 'left' | 'top' | 'right';
/**
 * Each player's discards lie on their right, next to the player who takes them:
 * you take from the pile on your left and throw onto the pile on your right.
 */
const CORNER: Record<Position | 'me', string> = { right: 'tr', top: 'tl', left: 'bl', me: 'br' };

/** Where opponents sit for each table size, in clockwise order after me. */
const LAYOUT: Record<number, Position[]> = { 2: ['top'], 3: ['right', 'left'], 4: ['right', 'top', 'left'] };

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  );
}
function Crown() {
  return (
    <svg viewBox="0 0 24 24" className="crown" aria-hidden="true">
      <path d="M3 18 L5 7 L10 12 L12 5 L14 12 L19 7 L21 18 Z" fill="currentColor" stroke="#7a5410" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** A burst of sparks; pure CSS, plays once on mount. */
function Sparks({ count = 14 }: { count?: number }) {
  return (
    <span className="sparks" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ '--a': `${(360 / count) * i}deg`, '--d': `${40 + (i % 3) * 18}px`, '--h': `${(i * 47) % 360}` } as CSSProperties} />
      ))}
    </span>
  );
}

function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 40 }, (_, i) => (
        <i key={i} style={{ '--x': `${(i * 37) % 100}%`, '--r': `${(i * 83) % 360}deg`, '--t': `${(i % 7) * 0.12}s`, '--c': ['#e8b84a', '#d93a2b', '#2f6fd6', '#f5ecd6', '#1fa37a'][i % 5] } as CSSProperties} />
      ))}
    </div>
  );
}

type DropKind = 'discard' | 'close';
interface Parked {
  id: string;
  kind: DropKind;
  from: DOMRect;
  to: DOMRect;
  confirmed: boolean;
}

/** A thrown tile settling from where it was let go onto its target, and staying there until the server answers. */
function ParkedTile({ parked }: { parked: Parked }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { from, to } = parked;
    const k = from.width / Math.max(1, to.width);
    const anim = el.animate(
      [
        { transform: `translate(${from.left}px, ${from.top}px) scale(${k}) rotate(-6deg)` },
        { transform: `translate(${to.left}px, ${to.top}px) scale(1.06) rotate(2deg)`, offset: 0.75 },
        { transform: `translate(${to.left}px, ${to.top}px) scale(1) rotate(0deg)` },
      ],
      { duration: reducedMotion() ? 0 : 230, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' },
    );
    return () => anim.cancel();
  }, [parked]);
  return (
    <div ref={ref} className={`parked-tile ${parked.kind === 'close' ? 'is-closing' : ''}`} style={{ width: parked.to.width }} aria-hidden="true">
      <TileFace id={parked.id} size="rack" />
    </div>
  );
}

interface Props {
  view: PlayerView;
  rack: RackEntry[];
  status: ConnectionStatus;
}

export function GameTable({ view, rack, status }: Props) {
  const s = view.state;
  const me = view.you.seat;
  const players = s.players.length ? s.players : [0, 1, 2, 3];
  const n = players.length;
  const myIdx = Math.max(0, players.indexOf(me));
  const order = Array.from({ length: n }, (_, k) => players[(myIdx + k) % n]!); // me first, then clockwise
  const opponents = order.slice(1).map((seat, i) => ({ seat, pos: (LAYOUT[n] ?? LAYOUT[4]!)[i]! }));
  const prevOf = (seat: number) => players[(players.indexOf(seat) + n - 1) % n]!;
  const prevSeat = prevOf(me);
  const name = (seat: number) => s.seats[seat]?.name ?? `Vendi ${seat + 1}`;

  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const { flights, launch, done } = useFlights();

  const inDeal = s.phase === 'AWAITING_DRAW' || s.phase === 'AWAITING_DISCARD';
  const myTurn = inDeal && s.activeSeat === me;
  const canDraw = myTurn && s.phase === 'AWAITING_DRAW';
  const canDiscard = myTurn && s.phase === 'AWAITING_DISCARD';
  const prevTop = s.seats[prevSeat]!.discardTop;
  const lastResult = s.results.at(-1) ?? null;
  const showResult = s.phase === 'ROUND_RESULT' || s.phase === 'TOURNAMENT_COMPLETE';

  // Drop a selection that is no longer on the rack (after a discard or a new deal).
  useEffect(() => {
    if (selected && !rack.some((e) => e.id === selected)) setSelected(null);
  }, [rack, selected]);
  const blocked = s.lastEvent?.type === 'deal_blocked' && s.lastEvent.dealId === s.dealId && s.turnId === 1;
  useEffect(() => {
    setMessage(blocked ? { text: 'Stoku mbaroi pa mbyllje: gurët u ndanë sërish.', tone: 'info' } : null);
    setScoreOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.dealId]);
  // Messages float over the table for a few seconds, then go.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.tone === 'error' ? 4500 : 3200);
    return () => clearTimeout(t);
  }, [message]);

  // Open the scoreboard for every newly scored round, after the table has had a moment to celebrate.
  const seenResults = useRef(showResult ? s.results.length - 1 : s.results.length);
  useEffect(() => {
    if (s.results.length > seenResults.current) {
      seenResults.current = s.results.length;
      const t = setTimeout(() => setScoreOpen(true), 1900);
      return () => clearTimeout(t);
    }
  }, [s.results.length]);

  // ---- flights: animate what just happened, from the previous view to this one -------------
  const prev = useRef<{ state: PublicState; rack: RackEntry[] } | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = { state: s, rack };
    const freshDeal = s.dealId && (before ? s.dealId !== before.state.dealId : s.turnId === 1 && inDeal);
    if (!before && !freshDeal) return;
    const b = before?.state ?? s;
    const ev = s.lastEvent;
    const reqs: FlightRequest[] = [];
    const tileW = document.querySelector('.rack .tile')?.getBoundingClientRect().width ?? 40;

    if (freshDeal) {
      // A fresh deal: tiles stream from the stock to every seat.
      const stock = anchorRect('stock');
      if (stock) {
        order.forEach((seat, k) => {
          const target = seat === me ? anchorRect('rack') : anchorRect(`opp-${seat}`);
          if (!target) return;
          for (let i = 0; i < 4; i++) reqs.push({ from: stock, to: tileBoxIn(target, seat === me ? tileW : 22), tile: null, delay: (i * n + k) * 70, duration: 420, arc: -40 });
        });
      }
    } else if (ev && s.turnId !== b.turnId && s.dealId === b.dealId) {
      if (ev.type === 'drew') {
        const from = ev.source === 'stock' ? anchorRect('stock') : anchorRect(`pile-${prevOf(ev.seat)}`);
        if (ev.seat === me) {
          const held = new Set((before?.rack ?? []).map((e) => e.id));
          const fresh = rack.find((e) => !held.has(e.id));
          const el = fresh && document.querySelector(`.rack [data-tile="${fresh.id}"]`);
          if (from && el) reqs.push({ from, to: el.getBoundingClientRect(), tile: fresh.id, arc: -70 });
        } else {
          const to = anchorRect(`opp-${ev.seat}`);
          const shown = ev.source === 'previous_discard' ? b.seats[prevOf(ev.seat)]!.discardTop : null;
          if (from && to) reqs.push({ from, to: tileBoxIn(to, from.width * 0.7), tile: shown, arc: -50 });
        }
      } else if (ev.type === 'discarded' && ev.seat !== me) {
        // My own throws are already lying on the pile (see `parked`); only opponents' tiles fly.
        const to = anchorRect(`pile-${ev.seat}`);
        const from = anchorRect(`opp-${ev.seat}`);
        if (from && to) reqs.push({ from: tileBoxIn(from, to.width * 0.6), to, tile: ev.tileId, arc: -80, duration: 480 });
      }
    }
    // The server has answered a throw of mine: the real pile (or the result) now shows the tile.
    if (parkedRef.current?.confirmed) {
      parkedRef.current = null;
      setParked(null);
      setLeaving(null);
    }
    launch(reqs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.version]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: ProtocolError }>, after?: () => void) => {
    setBusy(true);
    setMessage(null);
    const ack = await fn();
    setBusy(false);
    if (ack.ok) after?.();
    else if (ack.error && ack.error.code !== 'STALE_TURN' && ack.error.code !== 'STALE_DEAL') {
      setMessage({ text: errorText(ack.error), tone: 'error' });
    }
    return ack;
  };

  /** Tile I've thrown: hidden on the rack and lying where it was dropped until the server answers. */
  const [leaving, setLeaving] = useState<string | null>(null);
  const [parked, setParked] = useState<Parked | null>(null);
  const parkedRef = useRef<Parked | null>(null);
  const draw = (source: DrawSource) => !busy && canDraw && run(() => client.draw(source));
  /** Throw a tile onto my pile ('discard') or onto the stock to close the round ('close'). */
  const throwTile = (kind: DropKind, id: string, from?: DOMRect) => {
    if (busy || !canDiscard) return;
    const rackEl = document.querySelector(`.rack [data-tile="${id}"] .tile`);
    const start = from ?? rackEl?.getBoundingClientRect();
    const target = kind === 'discard' ? document.querySelector(`[data-anchor="pile-${me}"] .tile`) : document.querySelector('[data-anchor="stock"] .stack-1');
    const end = target?.getBoundingClientRect();
    const p: Parked = { id, kind, from: start ?? end!, to: end ?? start!, confirmed: false };
    if (start || end) {
      parkedRef.current = p;
      setParked(p);
    }
    setLeaving(id);
    setSelected(null);
    void run(() => (kind === 'close' ? client.declareWin(id) : client.discard(id))).then((ack) => {
      if (ack.ok && parkedRef.current === p) {
        // Keep it lying there until the new table state arrives (it follows the answer).
        p.confirmed = true;
        setTimeout(() => {
          if (parkedRef.current === p) {
            parkedRef.current = null;
            setParked(null);
            setLeaving(null);
          }
        }, 2500);
      } else {
        // Refused (e.g. the rest isn't all linked): the tile goes back to the rack.
        parkedRef.current = null;
        setParked(null);
        setLeaving(null);
      }
    });
  };
  const canThrow = canDiscard && !busy;
  const setReady = (ready: boolean) => run(() => client.setReady(ready));

  const myReady = s.seats[me]!.ready;
  const readyCount = players.filter((p) => s.seats[p]!.ready).length;
  const activeSeat = s.activeSeat !== null ? s.seats[s.activeSeat] : null;

  // Read out for screen readers; the table itself shows whose turn it is.
  let statusText: string;
  if (s.phase === 'TOURNAMENT_COMPLETE') statusText = `Turneu përfundoi. ${winnersText(s) ?? ''}`;
  else if (s.phase === 'ROUND_RESULT') statusText = `Raundi ${s.roundNumber} u mbyll. Gati për raundin tjetër: ${readyCount}/${n}.`;
  else if (canDraw) statusText = prevTop ? `Tërhiq një gur ose merr gurin që hodhi ${name(prevSeat)}.` : 'Tërhiq një gur nga stoku.';
  else if (canDiscard)
    statusText = 'Hidh një gur te hedhjet e tua, ose mbyll raundin duke vendosur gurin e fundit mbi stok.';
  else if (activeSeat && !activeSeat.connected) statusText = `${name(activeSeat.seat)} po rilidhet… Radha e pret.`;
  else statusText = activeSeat ? `Po luan ${name(activeSeat.seat)}${activeSeat.bot ? ' (bot)' : ''}…` : '';

  const justDiscarded = s.lastEvent?.type === 'discarded' ? s.lastEvent.seat : null;

  const deltaChip = (seat: number) =>
    showResult && lastResult ? (
      <span key={`d-${lastResult.roundNumber}`} className={`delta-chip ${lastResult.deltas[seat]! < 0 ? 'is-good' : lastResult.deltas[seat]! > 0 ? 'is-bad' : ''}`}>
        {formatScore(lastResult.deltas[seat]!)}
      </span>
    ) : null;

  const winnerMarks = (seat: number) => {
    const won = showResult && lastResult?.winner === seat;
    const champ = s.winners?.includes(seat);
    return (
      <>
        {(won || champ) && <Crown />}
        {won && <Sparks key={`sp-${lastResult!.roundNumber}`} />}
      </>
    );
  };

  const opponent = (seat: number, pos: Position) => {
    const p: PublicSeat = s.seats[seat]!;
    const active = inDeal && s.activeSeat === seat;
    const backs = Math.min(p.rackCount, 15);
    return (
      <div key={seat} className={`plaque plaque-${pos} ${active ? 'is-active' : ''} ${p.bot ? 'is-bot' : ''}`} aria-current={active ? 'true' : undefined}>
        <div className="plaque-card">
          <span className="avatar" aria-hidden="true">
            {p.bot ? <BotIcon /> : (p.name ?? '?').slice(0, 1).toLocaleUpperCase('sq')}
            {active && <span className="avatar-ring" />}
          </span>
          <span className="plaque-text">
            <span className="plaque-name">{p.name}</span>
            <span className="plaque-meta">
              {!p.connected ? (
                <span className="plaque-away">po rilidhet…</span>
              ) : s.phase === 'ROUND_RESULT' ? (
                p.ready ? 'gati' : 'pret'
              ) : active ? (
                <span className="thinking">
                  {p.bot ? 'mendon' : 'luan'}
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                `${p.rackCount} gurë`
              )}
              <span className="plaque-score">{formatScore(s.totals[seat]!)}</span>
            </span>
          </span>
          {winnerMarks(seat)}
          {deltaChip(seat)}
          {s.starter === seat && inDeal && <span className="sr-only">, filloi këtë dorë</span>}
        </div>
        <div className="mini-rack" data-anchor={`opp-${seat}`} key={`mr-${s.dealId}`} aria-hidden="true">
          {Array.from({ length: backs }, (_, i) => (
            <TileBack key={i} size="mini" className="mini" style={{ '--i': i } as CSSProperties} />
          ))}
        </div>
      </div>
    );
  };

  const pile = (seat: number, corner: string) => {
    const p = s.seats[seat]!;
    const takeable = canDraw && seat === prevSeat && p.discardTop !== null;
    const mine = seat === me;
    const label = `Hedhjet e ${seat === me ? 'tua' : name(seat)}`;
    const content = p.discardTop ? (
      <TileFace key={p.discardTop} id={p.discardTop} size="table" className={justDiscarded === seat && seat !== me ? 'is-landing' : ''} />
    ) : (
      <span className="tile tile-table tile-empty" aria-hidden="true" />
    );
    const under = Math.min(Math.max(0, p.discardCount - 1), 3);
    return (
      <div
        key={`pile-${seat}`}
        className={`pile pile-${corner} ${seat === prevSeat ? 'pile-prev' : ''} ${mine && canThrow ? 'can-drop' : ''}`}
        data-drop={mine && canThrow ? 'discard' : undefined}
      >
        <div className="pile-stack" data-anchor={`pile-${seat}`}>
          {Array.from({ length: under }, (_, i) => (
            <span key={i} className="tile tile-table tile-under" style={{ '--k': i + 1 } as CSSProperties} aria-hidden="true" />
          ))}
          {takeable ? (
            <button type="button" className="pile-take" onClick={() => draw('previous_discard')} disabled={busy} aria-label={`Merr gurin e hedhur nga ${name(seat)}: ${tileLabel(p.discardTop!)}`}>
              {content}
            </button>
          ) : mine && canThrow && selected ? (
            <button
              type="button"
              className="pile-throw"
              onClick={() => throwTile('discard', selected)}
              aria-label={`Hedhjet e tua: hidh këtu ${tileLabel(selected)}`}
            >
              {content}
            </button>
          ) : (
            <div className="pile-static" aria-label={`${label}: ${p.discardTop ? tileLabel(p.discardTop) : 'bosh'}`} role="img">
              {content}
            </div>
          )}
          {mine && canThrow && (
            <span className="drop-hint" aria-hidden="true">
              Hidh këtu
            </span>
          )}
        </div>
        <span className="pile-label">{seat === me ? 'Hedhjet e tua' : name(seat)}</span>
      </div>
    );
  };

  const stockStack = (
    <>
      <TileBack className="stack-3" />
      <TileBack className="stack-2" />
      <TileBack className="stack-1" />
      <span className="stock-count" aria-hidden="true">
        {s.stockCount}
      </span>
    </>
  );

  return (
    <div className={`game seats-${n}`}>
      <header className="topbar">
        <span className="wordmark wordmark-xs" aria-label="Zhol">
          Zhol
        </span>
        <span className="topbar-round">
          <span className="round-pips" aria-hidden="true">
            {Array.from({ length: s.totalRounds }, (_, i) => (
              <i key={i} className={i < s.results.length ? 'done' : i === s.results.length && inDeal ? 'now' : ''} />
            ))}
          </span>
          Raundi {Math.max(1, s.roundNumber)}/{s.totalRounds}
        </span>
        <ScoreSummary state={s} mySeat={me} />
        <div className="topbar-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setRulesOpen(true)} aria-label="Rregullat">
            ?
          </button>
          <button type="button" className="btn btn-small btn-secondary" onClick={() => setScoreOpen(true)}>
            Tabela e pikëve
          </button>
        </div>
      </header>

      {status !== 'connected' && (
        <p className="conn-banner" role="status">
          {status === 'replaced' ? 'Ky vend u hap në një skedë ose pajisje tjetër.' : status === 'offline' ? 'Nuk ka lidhje me serverin.' : 'Lidhja humbi. Po rilidhemi…'}
          {status === 'replaced' && (
            <button type="button" className="link-btn" onClick={() => client.retake()}>
              Luaj këtu
            </button>
          )}
        </p>
      )}

      <section className="table-rim" aria-label="Tavolina">
        <div className="felt">
          {opponents.map((o) => pile(o.seat, CORNER[o.pos]))}
          {opponents.map((o) => opponent(o.seat, o.pos))}
          <div className="center">
            {myTurn && (
              <span key={`${s.dealId}-${s.turnId}-${s.phase}`} className="turn-banner" aria-hidden="true">
                Radha jote!
              </span>
            )}
            {showResult ? (
              <div className="result-card" key={`res-${s.results.length}`}>
                {s.phase === 'TOURNAMENT_COMPLETE' && <Confetti />}
                <span className="result-kicker">{s.phase === 'TOURNAMENT_COMPLETE' ? 'Turneu mbaroi' : `Raundi ${lastResult?.roundNumber}`}</span>
                <p className="result-line">
                  {s.phase === 'TOURNAMENT_COMPLETE'
                    ? winnersText(s)
                    : lastResult && `${lastResult.winner === me ? 'Ti e mbylle' : `${name(lastResult.winner)} e mbylli`} raundin${lastResult.finishType === 'zhol' ? ' me Zhol!' : '!'}`}
                </p>
                {lastResult && <TileFace id={lastResult.finalDiscard} size="table" className="result-tile" />}
                <div className="result-actions">
                  <button type="button" className="btn btn-small btn-secondary" onClick={() => setScoreOpen(true)}>
                    Shiko pikët
                  </button>
                  {s.phase === 'ROUND_RESULT' && (
                    <button type="button" className={`btn btn-small ${myReady ? 'btn-ghost' : 'btn-primary btn-shine'}`} aria-pressed={myReady} onClick={() => setReady(!myReady)}>
                      {myReady ? `Gati ✓ (${readyCount}/${n})` : 'Jam gati'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className={`stock ${canThrow ? 'can-close' : ''}`} data-drop={canThrow ? 'close' : undefined}>
                  {canThrow && selected ? (
                    <button type="button" className="stock-btn stock-close" data-anchor="stock" onClick={() => throwTile('close', selected)} aria-label={`Mbyll raundin duke vendosur ${tileLabel(selected)} mbi stok`}>
                      {stockStack}
                    </button>
                  ) : canDraw ? (
                    <button type="button" className="stock-btn" data-anchor="stock" onClick={() => draw('stock')} disabled={busy || s.stockCount === 0} aria-label={`Tërhiq një gur nga stoku. Mbeten ${s.stockCount}.`}>
                      {stockStack}
                    </button>
                  ) : (
                    <div className="stock-static" data-anchor="stock" role="img" aria-label={`Stoku: ${s.stockCount} gurë`}>
                      {stockStack}
                    </div>
                  )}
                  <span className="center-label">Stoku</span>
                  {canThrow && (
                    <span className="drop-hint close-hint" aria-hidden="true">
                      Mbyll këtu
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
          {pile(me, CORNER.me)}
          <div className={`plaque plaque-bottom ${myTurn ? 'is-active' : ''}`}>
            <div className="plaque-card">
              <span className="avatar avatar-me" aria-hidden="true">
                {(name(me) ?? '?').slice(0, 1).toLocaleUpperCase('sq')}
                {myTurn && <span className="avatar-ring" />}
              </span>
              <span className="plaque-text">
                <span className="plaque-name">{name(me)} (ti)</span>
                <span className="plaque-meta">
                  <span className="plaque-score">{formatScore(s.totals[me]!)}</span>
                </span>
              </span>
              {winnerMarks(me)}
              {deltaChip(me)}
            </div>
          </div>
        </div>
      </section>

      <p className="sr-only" aria-live="polite">
        {statusText}
      </p>
      {message && (
        <p key={message.text} className={`toast ${message.tone === 'info' ? 'toast-info' : ''}`} role="alert" onClick={() => setMessage(null)}>
          {message.text}
        </p>
      )}

      <section className="rack-area" aria-label="Rafti">
        <div data-anchor="rack">
          <Rack
            rack={rack}
            selected={selected}
            onSelect={setSelected}
            onLayout={(l) => void client.sortRack(l)}
            dealKey={s.dealId}
            animateDeal={s.turnId === 1}
            canDrop={canThrow}
            onDrop={(kind, id, rect) => throwTile(kind, id, rect)}
            hiddenTile={leaving}
          />
        </div>
      </section>

      <FlightLayer flights={flights} onDone={done} />
      {parked && <ParkedTile key={parked.id} parked={parked} />}

      <Modal open={scoreOpen} title={s.phase === 'TOURNAMENT_COMPLETE' ? 'Rezultati përfundimtar' : 'Tabela e pikëve'} onClose={() => setScoreOpen(false)} wide>
        <ScoreTable state={s} mySeat={me} />
        <div className="modal-actions">
          {s.phase === 'ROUND_RESULT' && (
            <button type="button" className={`btn ${myReady ? 'btn-ghost' : 'btn-primary'}`} aria-pressed={myReady} onClick={() => setReady(!myReady)} data-autofocus>
              {myReady ? `Gati ✓ (${readyCount}/${n} gati)` : 'Jam gati'}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setScoreOpen(false)}>
            {s.phase === 'ROUND_RESULT' ? 'Shiko tavolinën' : 'Mbyll'}
          </button>
        </div>
      </Modal>
      <Modal open={rulesOpen} title="Rregullat e Zhol" onClose={() => setRulesOpen(false)}>
        <Rules />
      </Modal>
    </div>
  );
}
