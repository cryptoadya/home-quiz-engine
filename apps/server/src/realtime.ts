import { createServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { getRoom } from './rooms.js';
import { listPlayers } from './players.js';

const channel = (roomId: string, roster: boolean) => `lobby:${roomId}:${roster ? 'roster' : 'player'}`;

export function createQuizServer(db: DatabaseSync) {
  const app = createApp(db, roomId => {
    const room = getRoom(db, roomId);
    if (!room) return;
    io.to(channel(roomId, true)).emit('lobby:state', { room, players: listPlayers(db, roomId) });
    io.to(channel(roomId, false)).emit('lobby:state', { room });
  });
  const server = createServer(app);
  const io = new Server(server);
  io.on('connection', socket => {
    socket.on('lobby:subscribe', (input: unknown) => {
      // A socket watches one room/surface at a time, including after invalid requests.
      for (const name of socket.rooms) if (name !== socket.id) void socket.leave(name);
      const request = input as { roomId?: unknown; audience?: unknown } | null;
      if (typeof request?.roomId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.roomId)
        || typeof request.audience !== 'string' || !['host', 'screen', 'player'].includes(request.audience)) {
        socket.emit('lobby:error', { error: 'Invalid lobby subscription.' });
        return;
      }
      const room = getRoom(db, request.roomId);
      if (!room) { socket.emit('lobby:error', { error: 'Room not found.' }); return; }
      const roster = request.audience !== 'player';
      // SQLite reads and the local adapter are synchronous: no mutation can interleave
      // this fresh snapshot and subscription. Every reconnect repeats this operation.
      const state = roster ? { room, players: listPlayers(db, room.id) } : { room };
      void socket.join(channel(room.id, roster));
      socket.emit('lobby:state', state);
    });
  });
  return { app, server, io };
}
