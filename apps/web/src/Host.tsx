import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

type Room = { id: string; code: string; quizId: string; quizTitle: string; state: 'LOBBY'; createdAt: string; closedAt: string | null };

export function Host() {
  const { roomId } = useParams();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setRoom(null);
    setError('');
    fetch(`/api/rooms/${roomId}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load room.');
      if (active) setRoom(body);
    }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [roomId]);

  async function close() {
    if (!window.confirm('Close this room and release its code?')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/close`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not close room.');
      setRoom(body);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <main>
    <h1>Host</h1>
    <Link to="/admin">Quiz list</Link>
    {error && <p role="alert">{error}</p>}
    {!room && !error && <p>Loading room...</p>}
    {room && <>
      <h2>{room.quizTitle}</h2>
      <p>Room code: <strong>{room.code}</strong></p>
      <p>State: <span>Lobby</span></p>
      {room.closedAt ? <p role="status">Room closed</p> : <button onClick={() => void close()} disabled={busy}>Close room</button>}
    </>}
  </main>;
}
