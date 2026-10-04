import type { DatabaseSync } from 'node:sqlite';
import type { Server, Socket } from 'socket.io';
import { getQuiz } from './quizzes.js';

// Equipment checks are transient and never use game sessions or the game timer.
export function registerScreenCheck(io: Server, db: DatabaseSync) {
  const members = new Map<string, { quizId: string; role: 'admin' | 'screen' }>();
  let nextRevision = 0;
  const revisions = new Map<string, number>();
  const channel = (quizId: string, role: string) => `screen-check:${quizId}:${role}`;
  const screens = (quizId: string) => [...members.values()].filter(member => member.quizId === quizId && member.role === 'screen').length;
  const presence = (quizId: string) => io.to(channel(quizId, 'admin')).emit('screen-check:presence', { screens: screens(quizId) });
  io.on('connection', (socket: Socket) => {
    function leave() {
      const previous = members.get(socket.id);
      if (!previous) return;
      members.delete(socket.id);
      void socket.leave(channel(previous.quizId, previous.role));
      if (![...members.values()].some(member => member.quizId === previous.quizId && member.role === 'admin')) {
        io.to(channel(previous.quizId, 'screen')).emit('screen-check:command', { action: 'stop', revision: ++nextRevision });
        revisions.delete(previous.quizId);
      }
      presence(previous.quizId);
    }
    socket.on('disconnect', leave);
    socket.on('screen-check:subscribe', (input, ack) => {
      leave();
      const accepted = typeof input?.quizId === 'string' && ['admin', 'screen'].includes(input?.role) && !!getQuiz(db, input.quizId);
      if (accepted) {
        members.set(socket.id, { quizId: input.quizId, role: input.role });
        void socket.join(channel(input.quizId, input.role));
        presence(input.quizId);
      }
      if (typeof ack === 'function') ack({ accepted, screens: accepted ? screens(input.quizId) : 0 });
    });
    socket.on('screen-check:command', (input, ack) => {
      const member = members.get(socket.id);
      const accepted = member?.role === 'admin' && !!getQuiz(db, member.quizId) && screens(member.quizId) > 0 && ['picture', 'sound', 'stop'].includes(input?.action);
      if (accepted) {
        const revision = ++nextRevision;
        revisions.set(member!.quizId, revision);
        io.to(channel(member!.quizId, 'screen')).emit('screen-check:command', { action: input.action, revision });
      }
      if (typeof ack === 'function') ack({ accepted: !!accepted });
    });
    socket.on('screen-check:report', (input, ack) => {
      const member = members.get(socket.id);
      const accepted = member?.role === 'screen' && Number.isSafeInteger(input?.revision) && input?.revision === revisions.get(member.quizId) && ['picture', 'playing', 'ended', 'blocked', 'error', 'stopped'].includes(input?.status);
      if (accepted) io.to(channel(member!.quizId, 'admin')).emit('screen-check:report', { revision: input.revision, status: input.status });
      if (typeof ack === 'function') ack({ accepted: !!accepted });
    });
  });
}
