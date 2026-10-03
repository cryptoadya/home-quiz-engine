import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Host } from './Host';
import { Screen } from './Screen';

export function RoomRoute({ destination }: { destination: 'host' | 'screen' }) {
  const { roomId = '' } = useParams();
  const code = /^[a-z0-9]{5}$/i.test(roomId) ? roomId.toUpperCase() : null;
  const [resolved, setResolved] = useState<{ code: string; id?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!code) return;
    let active = true;
    setResolved(null);
    void (async () => {
      try {
        const response = await fetch(`/api/rooms/code/${encodeURIComponent(code)}`, { cache: 'no-store' });
        const room = await response.json();
        if (!response.ok || room.closedAt || !room.id) throw new Error('Room not found or closed. Ask the organizer for the current code.');
        if (active) setResolved({ code, id: room.id });
      } catch (cause) {
        if (active) setResolved({ code, error: (cause as Error).message });
      }
    })();
    return () => { active = false; };
  }, [code]);
  if (code && roomId !== code) return <Navigate to={`/${destination}/${code}`} replace />;
  if (code && (!resolved || resolved.code !== code || !resolved.id)) return <main>
    <h1>{destination === 'host' ? 'Host' : 'Screen'}</h1>
    {resolved?.code === code && resolved.error ? <p role="alert">{resolved.error}</p> : <p role="status">Finding room…</p>}
  </main>;
  const id = code ? resolved!.id! : roomId;
  return destination === 'host' ? <Host key={id} roomId={id} /> : <Screen key={id} roomId={id} />;
}
