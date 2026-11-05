import { useState, type FormEvent } from 'react';
import { ROOM_CODE_LENGTH } from '@zhol/protocol';
import { client, savedName } from '../lib/client';
import { errorText } from '../lib/i18n';
import { navigate } from '../lib/router';
import { TileFace } from './Tile';
import { Modal } from './Modal';
import { Rules } from './Rules';

export function Home() {
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Shkruaj emrin tënd për të krijuar dhomën.');
    setBusy('create');
    setError('');
    const ack = await client.createRoom(name);
    setBusy(null);
    if (ack.ok) navigate(ack.data.invitePath);
    else setError(errorText(ack.error));
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    // Accept a pasted invite link too.
    const fromLink = /\/room\/([A-Za-z0-9]+)/.exec(code)?.[1]?.toUpperCase();
    const finalCode = fromLink ?? c;
    if (finalCode.length !== ROOM_CODE_LENGTH) return setError(`Kodi i dhomës ka ${ROOM_CODE_LENGTH} shenja.`);
    navigate(`/room/${finalCode}`);
  };

  return (
    <main className="home">
      <div className="home-hero" aria-hidden="true">
        <TileFace id="u07a" size="table" className="hero-tile hero-t1" />
        <TileFace id="k07b" size="table" className="hero-tile hero-t2" />
        <TileFace id="z1" size="table" className="hero-tile hero-t3" />
        <TileFace id="r07b" size="table" className="hero-tile hero-t4" />
      </div>
      <h1 className="wordmark wordmark-hero">Zhol</h1>
      <p className="home-lede">2 deri në 4 shokë, një lidhje, ose luaj kundër botëve. Mblidh vargje e grupe dhe mbyll i pari.</p>

      <form className="panel" onSubmit={create} aria-labelledby="create-h">
        <h2 id="create-h" className="panel-title">Dhomë e re</h2>
        <label className="field">
          <span>Emri yt</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" required />
        </label>
        <button className="btn btn-primary" disabled={busy !== null}>
          {busy === 'create' ? 'Po krijohet…' : 'Krijo dhomë'}
        </button>
      </form>

      <form className="panel" onSubmit={join} aria-labelledby="join-h">
        <h2 id="join-h" className="panel-title">Ke një kod?</h2>
        <label className="field">
          <span>Kodi ose lidhja e dhomës</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
        </label>
        <button className="btn btn-secondary">Hyr në dhomë</button>
      </form>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="link-btn" onClick={() => setRulesOpen(true)}>
        Lexo rregullat
      </button>
      <Modal open={rulesOpen} title="Rregullat e Zhol" onClose={() => setRulesOpen(false)}>
        <Rules />
      </Modal>
    </main>
  );
}
