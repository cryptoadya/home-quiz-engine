import { completeMedia } from './media-playback.js';
import { createDeadlineManager } from './deadlines.js';
import { createServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { reconnectPlayer } from './players.js';
import { autoPauseForDisconnectedPlayer } from './pause.js';
import { getRoom } from './rooms.js';
import { getSurfaceState, type Audience } from './game.js';

const channel = (roomId: string, audience: Audience) => `lobby:${roomId}:${audience}`;

export function createQuizServer(db: DatabaseSync) {
  const presence = new Map<string, Set<string>>();
  const isPlayerPresent = (roomId: string, playerId: string) => (presence.get(`${roomId}:${playerId}`)?.size ?? 0) > 0;
  function broadcastPresence(roomId: string) {
    const state = getSurfaceState(db, roomId, 'host', Date.now(), isPlayerPresent);
    if (state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect') {
      io.to(channel(roomId, 'host')).emit('lobby:state', state);
    }
  }
  function broadcast(roomId: string) {
    for (const audience of ['host', 'screen', 'player'] as const) {
      const state = getSurfaceState(db, roomId, audience, Date.now(), isPlayerPresent);
      if (state) io.to(channel(roomId, audience)).emit('lobby:state', state);
    }
  }
  const deadlines = createDeadlineManager(db, broadcast);
  const app = createApp(db, roomId => {
    deadlines.sync(roomId);
    broadcast(roomId);
  }, isPlayerPresent);
  const server = createServer(app);
  const io = new Server(server);
  // Presence is process-local. Only an observed loss of the last authenticated
  // socket invokes the durable transaction; an empty registry at startup does not.
  io.on('connection', socket => {
    let screenRoom: string | undefined;
    socket.on('media:ended', (input: unknown, acknowledge?: (result: { accepted: boolean }) => void) => {
      const event = input as { roomId?: unknown; questionId?: unknown; mediaId?: unknown; revision?: unknown; duration?: unknown } | null;
      const accepted = !!screenRoom && event?.roomId === screenRoom && completeMedia(db, screenRoom, event.questionId, event.mediaId, event.revision, event.duration);
      if (accepted) { deadlines.sync(screenRoom!); broadcast(screenRoom!); }
      if (typeof acknowledge === 'function') acknowledge({ accepted });
    });
    let identity: { roomId: string; playerId: string } | undefined;
    function replacePresence(next?: typeof identity) {
      if (identity?.roomId === next?.roomId && identity?.playerId === next?.playerId) return;
      const previous = identity;
      identity = next;
      if (previous) {
        const key = `${previous.roomId}:${previous.playerId}`;
        const sockets = presence.get(key)!;
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          presence.delete(key);
          if (autoPauseForDisconnectedPlayer(db, previous.roomId, previous.playerId)) {
            deadlines.sync(previous.roomId);
            broadcast(previous.roomId);
          } else broadcastPresence(previous.roomId);
        }
      }
      if (next) {
        const key = `${next.roomId}:${next.playerId}`;
        const sockets = presence.get(key) ?? new Set<string>();
        const wasAbsent = sockets.size === 0;
        sockets.add(socket.id);
        presence.set(key, sockets);
        if (wasAbsent) broadcastPresence(next.roomId);
      }
    }
    socket.on('disconnect', () => replacePresence());
    socket.on('lobby:subscribe', (input: unknown) => {
      screenRoom = undefined;
      // A socket watches one room/surface at a time, including after invalid requests.
      for (const name of socket.rooms) if (name !== socket.id) void socket.leave(name);
      const request = input as { roomId?: unknown; audience?: unknown; token?: unknown } | null;
      if (typeof request?.roomId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.roomId)
        || typeof request.audience !== 'string' || !['host', 'screen', 'player'].includes(request.audience)) {
        replacePresence();
        socket.emit('lobby:error', { error: 'Invalid lobby subscription.' });
        return;
      }
      const room = getRoom(db, request.roomId);
      if (!room) { replacePresence(); socket.emit('lobby:error', { error: 'Room not found.' }); return; }
      const audience = request.audience as Audience;
      let next: typeof identity;
      if (audience === 'player') {
        const restored = reconnectPlayer(db, room.id, request.token);
        if ('status' in restored) {
          replacePresence();
          socket.emit('lobby:error', { error: restored.error });
          return;
        }
        next = { roomId: room.id, playerId: restored.player.id };
      }
      screenRoom = audience === 'screen' && !room.closedAt ? room.id : undefined;
      replacePresence(next);
      // SQLite reads and the local adapter are synchronous: no mutation can interleave
      // this fresh snapshot and subscription. Every reconnect repeats this operation.
      const state = getSurfaceState(db, room.id, audience, Date.now(), isPlayerPresent);
      void socket.join(channel(room.id, audience));
      socket.emit('lobby:state', state);
    });
  });
  deadlines.recover();
  server.on('close', () => deadlines.stop());
  return { app, server, io, deadlines };
}
