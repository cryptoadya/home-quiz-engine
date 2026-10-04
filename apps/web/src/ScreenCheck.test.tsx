import React from 'react';
import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanup, render, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.AudioContext;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; globalThis.AudioContext = originalAudio; dom.reconfigure({ url: 'http://localhost' }); });
function transport() {
  const events = new EventEmitter();
  const live = Object.assign(events, { connect() { events.emit('connect'); }, disconnect() {}, connected: true });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  live.on('screen-check:subscribe', (_input, acknowledge) => acknowledge({ accepted: true, screens: 1 }));
  return live;
}
function show(path: string) { return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); }

test('Admin replaces rehearsal with an equipment check that works for drafts and preserves the LAN port', async () => {
  dom.reconfigure({ url: 'http://localhost:5173' });
  const live = transport();
  let mutations = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') mutations++;
    const path = String(input);
    if (path === '/api/network') return Response.json({ addresses: [{ name: 'Wi-Fi', address: '192.168.1.50' }] });
    if (path.endsWith('/rounds') || path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    return Response.json({ id: 'quiz', title: 'Party', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false });
  };
  const view = show('/admin/quizzes/quiz');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Проверить экран и звук' })));
  assert.equal(view.queryByRole('button', { name: 'Rehearse with devices', hidden: true }), null);
  fireEvent.click(view.getByRole('button', { name: 'Проверить экран и звук' }));
  await waitFor(() => assert.equal(view.getByRole('link', { name: 'Открыть проверку на Screen' }).getAttribute('href'), 'http://192.168.1.50:5173/screen-check/quiz'));
  live.on('screen-check:command', (command, ack) => { assert.equal(command.action, 'sound'); ack({ accepted: true }); });
  fireEvent.click(view.getByRole('button', { name: 'Проиграть звук' }));
  await act(async () => { live.emit('screen-check:report', { revision: 1, status: 'blocked' }); });
  assert.ok(view.getByText(/Разрешить звук/));
  await act(async () => { live.emit('screen-check:presence', { screens: 0 }); });
  assert.equal((view.getByRole('button', { name: 'Проиграть звук' }) as HTMLButtonElement).disabled, true);
  assert.equal(mutations, 0);
});

test('standalone Screen shows a picture, reports blocked audio and permits a local recovery click', async () => {
  let unlocked = false;
  class Audio {
    state = unlocked ? 'running' : 'suspended';
    currentTime = 0;
    destination = {};
    resume() { return this.state === 'running' ? Promise.resolve() : new Promise<void>(() => {}); }
    close() { return Promise.resolve(); }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {}, onended: null }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  }
  globalThis.AudioContext = Audio as unknown as typeof AudioContext;
  const live = transport();
  const reports: string[] = [];
  live.on('screen-check:report', input => reports.push(input.status));
  const view = show('/screen-check/quiz');
  await act(async () => { live.emit('screen-check:command', { action: 'picture', revision: 1 }); });
  assert.ok(view.getByRole('img', { name: 'Тестовая картинка: рамка, круг и четыре цвета' }));
  await act(async () => { live.emit('screen-check:command', { action: 'sound', revision: 2 }); });
  assert.ok(view.getByRole('button', { name: 'Разрешить звук' }));
  assert.ok(reports.includes('blocked'));
  unlocked = true;
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Разрешить звук' })); });
  assert.ok(reports.includes('playing'));
  assert.equal(view.queryByRole('button', { name: 'Разрешить звук' }), null);
  await act(async () => { live.emit('screen-check:command', { action: 'stop', revision: 3 }); });
  assert.equal(view.queryByRole('button', { name: 'Разрешить звук' }), null);
  assert.equal(view.queryByRole('button', { name: /Start|Начать игру/ }), null);
});

test('a delayed sound permission cannot start a tone after Stop or after a replacement command', async () => {
  const live = transport();
  const contexts: { finish: () => void; closed: boolean; started: boolean }[] = [];
  class Audio {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    record = { finish: () => {}, closed: false, started: false };
    constructor() { contexts.push(this.record); }
    resume() { return new Promise<void>(resolve => { this.record.finish = () => { this.state = 'running'; resolve(); }; }); }
    close() { this.record.closed = true; return Promise.resolve(); }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start: () => { this.record.started = true; }, stop() {}, onended: null }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  }
  globalThis.AudioContext = Audio as unknown as typeof AudioContext;
  const view = show('/screen-check/quiz');
  await act(async () => { live.emit('screen-check:command', { action: 'sound', revision: 1 }); });
  await act(async () => { live.emit('screen-check:command', { action: 'sound', revision: 2 }); contexts[0].finish(); });
  assert.equal(contexts[0].closed, true); assert.equal(contexts[0].started, false);
  await act(async () => { live.emit('screen-check:command', { action: 'stop', revision: 3 }); contexts[1].finish(); });
  assert.equal(contexts[1].closed, true); assert.equal(contexts[1].started, false);
  assert.ok(view.getByText('Проверка остановлена.'));
});

test('Host uses Russian actions and a disconnected player can resume the same question only after reconnect', async () => {
  const live = transport();
  const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', state: 'PAUSED', closedAt: null };
  const game = { state: 'PAUSED', reason: 'player_disconnect', pausedFromState: 'ANSWERING', remainingMs: 10000, disconnectedPlayer: { id: 'player', name: 'Маша', present: false } };
  let submissions = 0;
  globalThis.fetch = async (_input, init) => { if (init?.method === 'POST') submissions++; return Response.json({ room, game, players: [] }); };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Продолжить с игроком' })));
  assert.equal((view.getByRole('button', { name: 'Продолжить с игроком' }) as HTMLButtonElement).disabled, true);
  await act(async () => live.emit('lobby:state', { room, game: { ...game, disconnectedPlayer: { ...game.disconnectedPlayer, present: true } }, players: [] }));
  assert.equal((view.getByRole('button', { name: 'Продолжить с игроком' }) as HTMLButtonElement).disabled, false);
  fireEvent.click(view.getByRole('button', { name: 'Продолжить с игроком' }));
  await waitFor(() => assert.equal(submissions, 1));
});
