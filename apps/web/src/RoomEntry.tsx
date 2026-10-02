import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Room } from './lobby';

export function RoomEntry({ destination }: { destination: 'host' | 'screen' }) {
  const [params] = useSearchParams();
  const code = params.get('code')?.trim().toUpperCase() ?? '';
  const session = params.get('session');
  const navigate = useNavigate();
  const [entered, setEntered] = useState(code);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!code) return;
    let active = true;
    setBusy(true); setError('');
    void (async () => {
      try {
        const response = await fetch(`/api/rooms/code/${encodeURIComponent(code)}`, { cache: 'no-store' });
        const room: Room & { error?: string } = await response.json();
        if (!response.ok || room.closedAt || !room.id) throw new Error('Room not found or closed. Ask the organizer for the current code.');
        if (session && room.shareKey !== session) throw new Error('This link has expired; its code now belongs to another room. Ask the organizer for a new link.');
        if (active) navigate(`/${destination}/${encodeURIComponent(room.id)}`, { replace: true });
      } catch (cause) { if (active) setError((cause as Error).message); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [code, session, destination, navigate, retry]);
  return <main><h1>{destination === 'host' ? 'Host' : 'Screen'}</h1>
    <p>Enter the current room code from the organizer.</p>
    {error && <p role="alert">{error}</p>}
    <form className="fields" onSubmit={event => {
      event.preventDefault();
      const next = entered.trim().toUpperCase();
      if (next === code) setRetry(value => value + 1);
      else navigate(`/${destination}?code=${encodeURIComponent(next)}`);
    }}>
      <label>Room code<input value={entered} onChange={event => setEntered(event.target.value)} required autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></label>
      <button disabled={busy}>Open room</button>
    </form>
    {busy && <p role="status">Finding room…</p>}
  </main>;
}
