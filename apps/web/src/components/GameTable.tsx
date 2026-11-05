import { useEffect, useRef, useState } from 'react';
import { RACK_SLOTS, type RackEntry, compareTileIds, parseTile } from '@zhol/engine';
import type { DrawSource, PlayerView, ProtocolError, PublicSeat } from '@zhol/protocol';
import { client, type ConnectionStatus } from '../lib/client';
import { errorText, formatScore, tileLabel } from '../lib/i18n';
import { Modal } from './Modal';
import { Rack } from './Rack';
import { Rules } from './Rules';
import { ScoreSummary, ScoreTable, winnersText } from './Scoreboard';
import { TileBack, TileFace } from './Tile';

type Position = 'bottom' | 'left' | 'top' | 'right';
const POSITIONS: Position[] = ['bottom', 'left', 'top', 'right'];

/** Lay out tiles with a blank slot between groups when they fit. */
function layoutGroups(groups: string[][]): RackEntry[] {
  const withGaps = groups.flatMap((g, i) => (i ? [null, ...g] : g));
  const seq = withGaps.length <= RACK_SLOTS ? withGaps : groups.flat();
  const out: RackEntry[] = [];
  seq.forEach((id, slot) => id && out.push({ id, slot }));
  return out;
}

function sortByColor(ids: string[]): RackEntry[] {
  const groups = new Map<string, string[]>();
  for (const id of [...ids].sort(compareTileIds)) {
    const t = parseTile(id);
    const key = t.kind === 'zhol' ? 'zhol' : t.color;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return layoutGroups([...groups.values()]);
}

function sortByNumber(ids: string[]): RackEntry[] {
  const groups = new Map<number, string[]>();
  const sorted = [...ids].sort((a, b) => {
    const ta = parseTile(a);
    const tb = parseTile(b);
    const ra = ta.kind === 'zhol' ? 99 : ta.rank;
    const rb = tb.kind === 'zhol' ? 99 : tb.rank;
    return ra - rb || compareTileIds(a, b);
  });
  for (const id of sorted) {
    const t = parseTile(id);
    const key = t.kind === 'zhol' ? 99 : t.rank;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return layoutGroups([...groups.values()]);
}

interface Props {
  view: PlayerView;
  rack: RackEntry[];
  status: ConnectionStatus;
}

export function GameTable({ view, rack, status }: Props) {
  const s = view.state;
  const me = view.you.seat;
  const seatAt = (pos: Position) => (me + POSITIONS.indexOf(pos)) % 4;
  const prevSeat = (me + 3) % 4;
  const name = (seat: number) => s.seats[seat]?.name ?? `Vendi ${seat + 1}`;

  const [selected, setSelected] = useState<string | null>(null);
  const [closeMode, setCloseMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  const inDeal = s.phase === 'AWAITING_DRAW' || s.phase === 'AWAITING_DISCARD';
  const myTurn = inDeal && s.activeSeat === me;
  const canDraw = myTurn && s.phase === 'AWAITING_DRAW';
  const canDiscard = myTurn && s.phase === 'AWAITING_DISCARD';
  const prevTop = s.seats[prevSeat]!.discardTop;

  // Drop a selection that is no longer on the rack (after a discard or a new deal).
  useEffect(() => {
    if (selected && !rack.some((e) => e.id === selected)) setSelected(null);
  }, [rack, selected]);
  useEffect(() => {
    // A new deal starts: leave close mode and put the result sheet away.
    setCloseMode(false);
    setMessage(null);
    setScoreOpen(false);
  }, [s.dealId]);
  useEffect(() => {
    if (!canDiscard) setCloseMode(false);
  }, [canDiscard]);

  // Open the scoreboard automatically for every newly scored round (and on reconnect into a result).
  const seenResults = useRef(s.phase === 'ROUND_RESULT' || s.phase === 'TOURNAMENT_COMPLETE' ? s.results.length - 1 : s.results.length);
  useEffect(() => {
    if (s.results.length > seenResults.current) {
      seenResults.current = s.results.length;
      setScoreOpen(true);
    }
  }, [s.results.length]);

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

  const draw = (source: DrawSource) => !busy && canDraw && run(() => client.draw(source));
  const discard = () => selected && !busy && run(() => client.discard(selected), () => setSelected(null));
  const confirmClose = () =>
    selected &&
    !busy &&
    run(
      () => client.declareWin(selected),
      () => {
        setSelected(null);
        setCloseMode(false);
      },
    );
  const setReady = (ready: boolean) => run(() => client.setReady(ready));

  const myReady = s.seats[me]!.ready;
  const readyCount = s.seats.filter((x) => x.ready).length;
  const activeSeat = s.activeSeat !== null ? s.seats[s.activeSeat] : null;

  let statusText: string;
  if (s.phase === 'TOURNAMENT_COMPLETE') statusText = `Turneu përfundoi. ${winnersText(s) ?? ''}`;
  else if (s.phase === 'ROUND_RESULT') statusText = `Raundi ${s.roundNumber} u mbyll. Gati për raundin tjetër: ${readyCount}/4.`;
  else if (canDraw) statusText = prevTop ? `Radha jote: tërhiq një gur ose merr gurin që hodhi ${name(prevSeat)}.` : 'Radha jote: tërhiq një gur nga stoku.';
  else if (canDiscard)
    statusText = closeMode
      ? 'Zgjidh gurin e fundit që do hedhësh, pastaj konfirmo mbylljen.'
      : rack.length === 15 && s.seats.every((x) => x.discardCount === 0)
        ? 'Ti fillon me 15 gurë: zgjidh një gur dhe hidhe, ose mbyll raundin.'
        : 'Zgjidh një gur dhe hidhe, ose mbyll raundin.';
  else if (activeSeat && !activeSeat.connected) statusText = `${name(activeSeat.seat)} po rilidhet… Radha e pret.`;
  else statusText = activeSeat ? `Po luan ${name(activeSeat.seat)}.` : '';

  const blocked = s.lastEvent?.type === 'deal_blocked' && s.lastEvent.dealId === s.dealId && s.turnId === 1;

  const opponent = (pos: Position) => {
    const seat: PublicSeat = s.seats[seatAt(pos)]!;
    const active = inDeal && s.activeSeat === seat.seat;
    return (
      <div className={`plaque plaque-${pos} ${active ? 'is-active' : ''}`} aria-current={active ? 'true' : undefined}>
        <span className="plaque-name">{seat.name}</span>
        <span className="plaque-meta">
          {!seat.connected ? (
            <span className="plaque-away">po rilidhet…</span>
          ) : s.phase === 'ROUND_RESULT' ? (
            seat.ready ? 'gati' : 'pret'
          ) : (
            `${seat.rackCount} gurë`
          )}
          <span className="plaque-score">{formatScore(s.totals[seat.seat]!)}</span>
        </span>
        {s.starter === seat.seat && inDeal && <span className="sr-only">, filloi këtë dorë</span>}
      </div>
    );
  };

  const pile = (seat: number, corner: string) => {
    const p = s.seats[seat]!;
    const takeable = canDraw && seat === prevSeat && p.discardTop !== null;
    const label = `Hedhjet e ${seat === me ? 'tua' : name(seat)}`;
    const content = p.discardTop ? <TileFace id={p.discardTop} size="table" /> : <span className="tile tile-table tile-empty" aria-hidden="true" />;
    return (
      <div className={`pile pile-${corner} ${seat === prevSeat ? 'pile-prev' : ''}`}>
        {takeable ? (
          <button
            type="button"
            className="pile-take"
            onClick={() => draw('previous_discard')}
            disabled={busy}
            aria-label={`Merr gurin e hedhur nga ${name(seat)}: ${tileLabel(p.discardTop!)}`}
          >
            {content}
          </button>
        ) : (
          <div className="pile-static" aria-label={`${label}: ${p.discardTop ? tileLabel(p.discardTop) : 'bosh'}`} role="img">
            {content}
          </div>
        )}
        <span className="pile-label">{seat === me ? 'Hedhjet e tua' : name(seat)}</span>
      </div>
    );
  };

  return (
    <div className="game">
      <header className="topbar">
        <span className="wordmark wordmark-xs" aria-label="Zhol">
          Zhol
        </span>
        <span className="topbar-round">
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
          {status === 'replaced'
            ? 'Ky vend u hap në një skedë ose pajisje tjetër.'
            : status === 'offline'
              ? 'Nuk ka lidhje me serverin.'
              : 'Lidhja humbi. Po rilidhemi…'}
          {status === 'replaced' && (
            <button type="button" className="link-btn" onClick={() => client.retake()}>
              Luaj këtu
            </button>
          )}
        </p>
      )}

      <section className="felt" aria-label="Tavolina">
        {pile(seatAt('left'), 'tl')}
        {opponent('top')}
        {pile(seatAt('top'), 'tr')}
        {opponent('left')}
        <div className="center">
          {s.phase === 'ROUND_RESULT' || s.phase === 'TOURNAMENT_COMPLETE' ? (
            <div className="result-card">
              <p className="result-line">
                {s.phase === 'TOURNAMENT_COMPLETE'
                  ? winnersText(s)
                  : (() => {
                      const r = s.results.at(-1)!;
                      return `${name(r.winner)} mbylli raundin ${r.roundNumber}${r.finishType === 'zhol' ? ' me Zhol' : ''}.`;
                    })()}
              </p>
              <button type="button" className="btn btn-small btn-secondary" onClick={() => setScoreOpen(true)}>
                Shiko pikët
              </button>
              {s.phase === 'ROUND_RESULT' && (
                <button type="button" className={`btn btn-small ${myReady ? 'btn-ghost' : 'btn-primary'}`} aria-pressed={myReady} onClick={() => setReady(!myReady)}>
                  {myReady ? `Gati ✓ (${readyCount}/4)` : 'Jam gati'}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="indicator">
                {s.indicator && <TileFace id={s.indicator} size="table" />}
                <span className="center-label">Treguesi</span>
              </div>
              <div className="stock">
                {canDraw ? (
                  <button type="button" className="stock-btn" onClick={() => draw('stock')} disabled={busy || s.stockCount === 0} aria-label={`Tërhiq një gur nga stoku. Mbeten ${s.stockCount}.`}>
                    <TileBack />
                    <TileBack className="stack-2" />
                  </button>
                ) : (
                  <div className="stock-static" role="img" aria-label={`Stoku: ${s.stockCount} gurë`}>
                    <TileBack />
                    <TileBack className="stack-2" />
                  </div>
                )}
                <span className="center-label">Stoku: {s.stockCount}</span>
              </div>
            </>
          )}
        </div>
        {opponent('right')}
        {pile(me, 'bl')}
        <div className={`plaque plaque-bottom ${myTurn ? 'is-active' : ''}`}>
          <span className="plaque-name">{name(me)} (ti)</span>
          <span className="plaque-meta">
            <span className="plaque-score">{formatScore(s.totals[me]!)}</span>
          </span>
        </div>
        {pile(seatAt('right'), 'br')}
      </section>

      <section className="controls" aria-label="Veprimet">
        <p className={`status ${myTurn ? 'status-turn' : ''}`} aria-live="polite">
          {blocked && <span className="status-note">Dora e mëparshme u bllokua: stoku mbaroi pa mbyllje. Gurët u ndanë sërish. </span>}
          {statusText}
        </p>
        {message && (
          <p className={`alert ${message.tone === 'info' ? 'alert-info' : ''}`} role="alert">
            {message.text}
          </p>
        )}
        <div className="action-row">
          {canDraw && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => draw('stock')} disabled={busy}>
                Tërhiq një gur
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => draw('previous_discard')} disabled={busy || !prevTop}>
                Merr gurin e hedhur
              </button>
            </>
          )}
          {canDiscard && !closeMode && (
            <>
              <button type="button" className="btn btn-primary" onClick={discard} disabled={busy || !selected}>
                {selected ? `Hidh ${tileLabel(selected)}` : 'Hidh'}
              </button>
              <button
                type="button"
                className="btn btn-gold"
                onClick={() => {
                  setCloseMode(true);
                  setMessage(null);
                }}
                disabled={busy}
              >
                Mbyll raundin
              </button>
            </>
          )}
          {canDiscard && closeMode && (
            <>
              <button type="button" className="btn btn-gold" onClick={confirmClose} disabled={busy || !selected}>
                {selected ? `Konfirmo mbylljen duke hedhur ${tileLabel(selected)}` : 'Zgjidh gurin për ta hedhur'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setCloseMode(false)}>
                Anulo
              </button>
            </>
          )}
          {!myTurn && inDeal && <span className="muted small">Mund ta rendisësh raftin edhe kur s’është radha jote.</span>}
        </div>
      </section>

      <section className="rack-area" aria-label="Rafti">
        <Rack rack={rack} selected={selected} onSelect={setSelected} onLayout={(l) => void client.sortRack(l)} />
        <div className="sort-row">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void client.sortRack(sortByColor(rack.map((e) => e.id)))} disabled={!rack.length}>
            Rendit sipas ngjyrës
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void client.sortRack(sortByNumber(rack.map((e) => e.id)))} disabled={!rack.length}>
            Rendit sipas numrit
          </button>
        </div>
      </section>

      <Modal open={scoreOpen} title={s.phase === 'TOURNAMENT_COMPLETE' ? 'Rezultati përfundimtar' : 'Tabela e pikëve'} onClose={() => setScoreOpen(false)} wide>
        <ScoreTable state={s} mySeat={me} />
        <div className="modal-actions">
          {s.phase === 'ROUND_RESULT' && (
            <button type="button" className={`btn ${myReady ? 'btn-ghost' : 'btn-primary'}`} aria-pressed={myReady} onClick={() => setReady(!myReady)} data-autofocus>
              {myReady ? `Gati ✓ (${readyCount}/4 gati)` : 'Jam gati'}
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
