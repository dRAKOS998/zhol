import { useEffect, useState, type FormEvent } from 'react';
import { client, displayRack, savedName, useClient } from '../lib/client';
import { errorText } from '../lib/i18n';
import { navigate } from '../lib/router';
import { GameTable } from './GameTable';
import { Lobby } from './Lobby';

export function RoomPage({ code }: { code: string }) {
  const snap = useClient();
  const [needsName, setNeedsName] = useState(false);
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setNeedsName(!client.enterRoom(code));
  }, [code]);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Shkruaj emrin tënd.');
    setBusy(true);
    setError('');
    const ack = await client.joinRoom(code, name);
    setBusy(false);
    if (ack.ok) setNeedsName(false);
    else setError(errorText(ack.error));
  };

  const view = snap.view && snap.view.state.code === code ? snap.view : null;

  if (view) {
    return view.state.phase === 'LOBBY' ? (
      <Lobby state={view.state} mySeat={view.you.seat} />
    ) : (
      <GameTable view={view} rack={displayRack(snap)} status={snap.status} />
    );
  }

  if (needsName || snap.reclaimError) {
    return (
      <main className="home">
        <h1 className="wordmark wordmark-sm">Zhol</h1>
        <form className="panel" onSubmit={join} aria-labelledby="join-h">
          <h2 id="join-h" className="panel-title">
            Hyr në dhomën {code}
          </h2>
          {snap.reclaimError && !error && (
            <p className="alert" role="alert">
              {errorText(snap.reclaimError)}
            </p>
          )}
          <label className="field">
            <span>Emri yt</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" required autoFocus />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Po hyn…' : 'Hyr në dhomë'}
          </button>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </form>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            client.leaveRoomView();
            navigate('/');
          }}
        >
          Kthehu në fillim
        </button>
      </main>
    );
  }

  return (
    <main className="home">
      <h1 className="wordmark wordmark-sm">Zhol</h1>
      <p className="muted" role="status">
        {snap.status === 'offline' ? 'Serveri nuk po përgjigjet. Po provojmë sërish…' : 'Po lidhemi me dhomën…'}
      </p>
    </main>
  );
}
