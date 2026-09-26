import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useLobby } from './lobby';

export function Host() {
  const { roomId } = useParams();
  const { state, setState, error: loadError, connected } = useLobby(roomId, 'host');
  const room = state?.room;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function close() {
    if (!window.confirm('Close this room and release its code?')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/close`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not close room.');
      setState(current => ({ room: body, players: current?.players ?? [] }));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <main>
    <h1>Host</h1>
    <Link to="/admin">Quiz list</Link>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!room && !error && !loadError && <p>Loading room...</p>}
    {room && <>
      <h2>{room.quizTitle}</h2>
      <Link to={`/screen/${room.id}`}>Open Screen</Link>
      <p>{connected ? 'Connected' : 'Reconnecting…'}</p>
      <p>Players: {state?.players?.length ?? 0} / 30</p>
      <ul>{state?.players?.map(player => <li key={player.id}>{player.name} — {player.language.toUpperCase()}</li>)}</ul>
      <p>Room code: <strong>{room.code}</strong></p>
      <p>State: <span>Lobby</span></p>
      {room.closedAt ? <p role="status">Room closed</p> : <button onClick={() => void close()} disabled={busy}>Close room</button>}
    </>}
  </main>;
}
