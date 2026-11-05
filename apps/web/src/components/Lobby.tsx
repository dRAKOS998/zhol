import { useState } from 'react';
import type { PublicState } from '@zhol/protocol';
import { client } from '../lib/client';
import { errorText } from '../lib/i18n';
import { Modal } from './Modal';
import { Rules } from './Rules';

export function Lobby({ state, mySeat }: { state: PublicState; mySeat: number }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [error, setError] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const link = `${window.location.origin}/room/${state.code}`;
  const me = state.seats[mySeat]!;
  const seated = state.seats.filter((s) => s.name).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  const toggleReady = async () => {
    setError('');
    const ack = await client.setReady(!me.ready);
    if (!ack.ok) setError(errorText(ack.error));
  };

  return (
    <main className="lobby">
      <h1 className="wordmark wordmark-sm">Zhol</h1>
      <section className="panel" aria-labelledby="invite-h">
        <h2 id="invite-h" className="panel-title">Fto tre shokë</h2>
        <p className="muted">Dërgoju këtë lidhje. Kush e hap, ulet direkt në këtë dhomë.</p>
        <div className="invite">
          <code className="invite-link" aria-label="Lidhja e dhomës">
            {link}
          </code>
          <button type="button" className="btn btn-secondary" onClick={copy}>
            Kopjo lidhjen
          </button>
        </div>
        <p className="muted small" aria-live="polite">
          {copied === 'ok' ? 'Lidhja u kopjua.' : copied === 'fail' ? 'Kopjimi nuk u lejua nga shfletuesi. Zgjidhe lidhjen dhe kopjoje me dorë.' : `Kodi i dhomës: ${state.code}`}
        </p>
      </section>

      <section className="panel" aria-labelledby="seats-h">
        <h2 id="seats-h" className="panel-title">
          Lojtarët ({seated}/4)
        </h2>
        <ol className="seats">
          {state.seats.map((s) => (
            <li key={s.seat} className={`seat ${s.name ? '' : 'seat-empty'} ${s.seat === mySeat ? 'is-me' : ''}`}>
              <span className="seat-name">
                {s.name ?? 'Vend i lirë'}
                {s.seat === mySeat && <span className="muted"> (ti)</span>}
              </span>
              <span className={`seat-status ${s.ready ? 'is-ready' : ''}`}>
                {!s.name ? 'Në pritje' : !s.connected ? 'Jo i lidhur' : s.ready ? 'Gati' : 'Jo ende gati'}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className={`btn ${me.ready ? 'btn-secondary' : 'btn-primary'}`} aria-pressed={me.ready} onClick={toggleReady}>
          {me.ready ? 'Gati ✓ (prek për ta anuluar)' : 'Jam gati'}
        </button>
        <p className="muted small">
          {seated < 4 ? 'Loja nis kur janë katër lojtarë dhe të gjithë kanë shtypur «Jam gati».' : 'Loja nis sapo të gjithë të jenë gati.'}
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
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
