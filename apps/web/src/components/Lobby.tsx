import { useState } from 'react';
import type { PublicSeat, PublicState } from '@zhol/protocol';
import { client } from '../lib/client';
import { errorText } from '../lib/i18n';
import { Modal } from './Modal';
import { Rules } from './Rules';
import { TileBack, TileFace } from './Tile';

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  );
}
function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Me at the bottom, the next player on my right, then across, then on my left.
const CHAIRS = ['chair-s', 'chair-e', 'chair-n', 'chair-w'] as const;

export function Lobby({ state, mySeat }: { state: PublicState; mySeat: number }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const link = `${window.location.origin}/room/${state.code}`;
  const me = state.seats[mySeat]!;
  const isHost = state.host === mySeat;
  const taken = state.seats.filter((s) => s.name);
  const seated = taken.length;
  const humansWaiting = taken.filter((s) => !s.bot && !s.ready && s.seat !== mySeat);
  const canStart = seated >= state.minPlayers && humansWaiting.length === 0;

  const run = async (fn: () => Promise<{ ok: boolean; error?: Parameters<typeof errorText>[0] }>) => {
    setBusy(true);
    setError('');
    const ack = await fn();
    setBusy(false);
    if (!ack.ok) setError(errorText(ack.error));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  // Seats drawn around the table from my point of view: me at the bottom, then clockwise.
  const around = [0, 1, 2, 3].map((k) => state.seats[(mySeat + k) % 4]!);

  const seatCard = (s: PublicSeat, chair: string, i: number) => {
    const empty = !s.name;
    const mine = s.seat === mySeat;
    return (
      <li key={s.seat} className={`lobby-seat ${chair} ${empty ? 'is-empty' : 'is-taken'} ${s.bot ? 'is-bot' : ''} ${mine ? 'is-me' : ''} ${s.ready ? 'is-ready' : ''}`} style={{ '--i': i } as React.CSSProperties}>
        {empty ? (
          isHost ? (
            <button type="button" className="seat-add" onClick={() => run(() => client.addBot(s.seat))} disabled={busy} aria-label={`Shto një bot në vendin ${s.seat + 1}`}>
              <PlusIcon />
              <span>Shto bot</span>
            </button>
          ) : (
            <span className="seat-wait">
              <span className="seat-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Vend i lirë
            </span>
          )
        ) : (
          <>
            <span className="seat-avatar" aria-hidden="true">
              {s.bot ? <BotIcon /> : <PersonIcon />}
            </span>
            <span className="seat-who">
              <span className="seat-name">
                {s.name}
                {mine && <span className="seat-you"> (ti)</span>}
              </span>
              <span className="seat-state">
                {s.seat === state.host && !s.bot ? 'Pritësi · ' : ''}
                {s.bot ? 'Bot · gati' : !s.connected ? 'Jo i lidhur' : s.ready ? 'Gati' : 'Jo ende gati'}
              </span>
            </span>
            {s.bot && isHost && (
              <button type="button" className="seat-remove" onClick={() => run(() => client.removeBot(s.seat))} disabled={busy} aria-label={`Hiq ${s.name}`}>
                <CloseIcon />
              </button>
            )}
            {s.ready && <span className="seat-check" aria-hidden="true" />}
          </>
        )}
      </li>
    );
  };

  let hint: string;
  if (seated < state.minPlayers) hint = isHost ? 'Fto një shok me lidhjen ose shto një bot. Loja nis me 2 deri në 4 lojtarë.' : 'Duhet edhe të paktën një lojtar tjetër.';
  else if (isHost && humansWaiting.length) hint = `Po presim: ${humansWaiting.map((s) => s.name).join(', ')}.`;
  else if (isHost) hint = `Gati për ${seated} lojtarë · ${seated} raunde.`;
  else hint = me.ready ? 'Pritësi do ta nisë lojën.' : 'Shtyp «Jam gati» kur të jesh gati.';

  return (
    <main className="lobby">
      <header className="lobby-head">
        <h1 className="wordmark wordmark-sm">Zhol</h1>
        <span className="room-chip">Dhoma {state.code}</span>
      </header>

      <section className="lobby-table" aria-labelledby="seats-h">
        <h2 id="seats-h" className="sr-only">
          Lojtarët ({seated}/4)
        </h2>
        <ol className="lobby-ring">{around.map((s, i) => seatCard(s, CHAIRS[i]!, i))}</ol>
        <div className="lobby-felt" aria-hidden="true">
          <div className="lobby-tiles">
            <TileFace id="r07a" size="table" className="float-a" />
            <TileFace id="z1" size="table" className="float-b" />
            <TileBack className="float-c" />
          </div>
          <span className="lobby-count">
            <b>{seated}</b>/4
          </span>
        </div>
      </section>

      <section className="panel lobby-actions" aria-live="polite">
        {isHost ? (
          <>
            <button type="button" className="btn btn-primary btn-big btn-shine" onClick={() => run(() => client.startGame())} disabled={busy || !canStart}>
              Fillo lojën{seated >= state.minPlayers ? ` · ${seated} lojtarë` : ''}
            </button>
            {seated < 4 && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    let last = { ok: true } as Awaited<ReturnType<typeof client.addBot>>;
                    for (let k = seated; k < 4 && last.ok; k++) last = await client.addBot();
                    return last;
                  })
                }
              >
                <BotIcon /> Mbush vendet me bot
              </button>
            )}
          </>
        ) : (
          <button type="button" className={`btn btn-big ${me.ready ? 'btn-secondary' : 'btn-primary btn-shine'}`} aria-pressed={me.ready} onClick={() => run(() => client.setReady(!me.ready))} disabled={busy}>
            {me.ready ? 'Gati ✓ · prek për ta anuluar' : 'Jam gati'}
          </button>
        )}
        <p className="muted small lobby-hint">{hint}</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="invite-h">
        <h2 id="invite-h" className="panel-title">
          Fto shokët
        </h2>
        <p className="muted small">Kush hap lidhjen, ulet direkt në një vend të lirë.</p>
        <div className="invite">
          <code className="invite-link" aria-label="Lidhja e dhomës">
            {link}
          </code>
          <button type="button" className="btn btn-secondary" onClick={copy}>
            {copied === 'ok' ? 'U kopjua ✓' : 'Kopjo lidhjen'}
          </button>
        </div>
        {copied === 'fail' && <p className="muted small">Kopjimi nuk u lejua nga shfletuesi. Zgjidhe lidhjen dhe kopjoje me dorë.</p>}
      </section>

      <button type="button" className="link-btn" onClick={() => setRulesOpen(true)}>
        Lexo rregullat
      </button>
      <Modal open={rulesOpen} title="Rregullat e Zhol" onClose={() => setRulesOpen(false)}>
        <Rules />
      </Modal>
    </main>
  );
}
