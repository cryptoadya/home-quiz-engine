import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export type Room = { id: string; code: string; quizTitle: string; state: string; closedAt: string | null };
export type LobbyState = { room: Room; players?: { id: string; name: string; language: 'ru' | 'en'; joinedAt: string }[] };
type Audience = 'host' | 'screen' | 'player';
export const lobbyTransport = { connect: () => io({ autoConnect: false }) };

export function useLobby(roomId: string | undefined, audience: Audience) {
  const [state, setState] = useState<LobbyState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setState(null); setError(''); setConnected(false);
    if (!roomId) return;
    let active = true;
    let receivedSnapshot = false;
    // HTTP provides initial/reload state even before the realtime connection is ready.
    // A socket snapshot always supersedes any earlier, slower HTTP response.
    if (audience !== 'player') {
      void fetch(`/api/rooms/${encodeURIComponent(roomId)}/lobby`, { cache: 'no-store' })
        .then(async response => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not load room.');
          if (active && !receivedSnapshot) setState(body);
        }).catch((cause: Error) => { if (active && !receivedSnapshot) setError(cause.message); });
    }
    const socket = lobbyTransport.connect();
    socket.on('connect', () => {
      // The subscription returns a fresh SQLite snapshot on EVERY connection;
      // no event history or client cache is used for recovery.
      socket.emit('lobby:subscribe', { roomId, audience });
    });
    socket.on('lobby:state', (snapshot: LobbyState) => {
      if (!active || snapshot.room.id !== roomId) return;
      receivedSnapshot = true;
      setState(snapshot); setError(''); setConnected(true);
    });
    socket.on('lobby:error', (body: { error: string }) => { setError(body.error); setConnected(false); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.connect();
    return () => { active = false; socket.removeAllListeners(); socket.disconnect(); };
  }, [roomId, audience]);
  return { state, setState, error, connected };
}
