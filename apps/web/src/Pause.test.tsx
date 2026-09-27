import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', state: 'QUESTION', closedAt: null };
const question = { state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question text', options: [] };
const timer = (now: number, remainingMs: number) => ({ serverNow: new Date(now).toISOString(), deadlineAt: new Date(now + remainingMs).toISOString(), remainingMs, durationSeconds: 12, expired: false });
const paused = { room: { ...room, state: 'PAUSED' }, game: { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 10000 } };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
function socket() {
  const live = Object.assign(new EventEmitter(), { connect() {}, disconnect() {} });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  return live;
}

for (const state of ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'LOBBY', 'WINNER_SCREEN']) {
  test(`Host Pause eligibility: ${state}`, async () => {
    socket();
    globalThis.fetch = async () => Response.json({ room: { ...room, state } });
    const view = show('/host/room');
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.equal(Boolean(view.queryByRole('button', { name: 'Pause' })), !['LOBBY', 'WINNER_SCREEN'].includes(state));
  });
}

test('Host Pause hides progression, reload restores pause, Resume restores prior surface, and closure wins', async () => {
  const live = socket();
  let snapshot = { room, game: question } as unknown;
  const commands: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      commands.push(String(url).split('/').at(-1)!);
      snapshot = commands.at(-1) === 'pause' ? { ...paused, game: { ...paused.game, pausedFromState: 'QUESTION', remainingMs: null } } : { room, game: question };
    }
    return Response.json(snapshot);
  };
  let view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Start Question' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Pause' })); });
  assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), ['Resume', 'Close room']);
  view.unmount(); view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Resume' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Resume' })); });
  assert.ok(view.getByRole('button', { name: 'Start Question' }));
  assert.deepEqual(commands, ['pause', 'resume']);
  await act(async () => { live.emit('lobby:state', { ...paused, room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText('Room closed'));
  assert.equal(view.queryByRole('button'), null);
});

for (const audience of ['host', 'screen']) test(`${audience} pause removes countdown through elapsed time and reload; Resume uses new timer`, async t => {
  const live = socket();
  let elapsed = 0;
  mock.method(performance, 'now', () => elapsed);
  let snapshot: unknown = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(0, 12000) } };
  globalThis.fetch = async () => Response.json(snapshot);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let view = show(`/${audience}/room`);
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '12'));
  elapsed = 2000;
  await act(async () => { t.mock.timers.tick(2000); });
  assert.equal(view.getByRole('timer').textContent, '10');
  snapshot = paused;
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.equal(view.queryByRole('timer'), null);
  if (audience === 'screen') assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
  elapsed = 62000;
  await act(async () => { t.mock.timers.tick(60000); });
  view.unmount(); view = show(`/${audience}/room`);
  await act(async () => {});
  assert.equal(view.queryByRole('timer'), null);
  snapshot = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(62000, 10000) } };
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.equal(view.getByRole('timer').textContent, '10');
  elapsed = 63000;
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(view.getByRole('timer').textContent, '9');
  await act(async () => { live.emit('lobby:state', { ...paused, room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText(/Room closed/));
  assert.equal(view.queryByRole('heading', { name: 'Пауза / Paused' }), null);
});

for (const language of ['ru', 'en']) for (const reload of [false, true]) test(`Player ${language} pause hides answers; reload=${reload} and Resume refetch preserve accepted answer and new deadline`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ANSWERING';
  let remaining = 12000;
  let pending: ((response: Response) => void) | undefined;
  const identity = () => ({ room: { ...room, state: phase }, active: true, player: { id: 'p', name: 'Alex', language },
    game: phase === 'ANSWERING' ? { state: 'ANSWERING', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: true, optionId: 'a' }, timer: timer(62000, remaining) } : null });
  globalThis.fetch = async () => Response.json(identity());
  let view = show('/play/ABCDE');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '12'));
  phase = 'PAUSED';
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  const label = language === 'ru' ? 'Пауза' : 'Paused';
  assert.ok(view.getByText(label));
  assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('radio'), null);
  if (reload) {
    view.unmount(); view = show('/play/ABCDE');
    await waitFor(() => assert.ok(view.getByText(label)));
  }
  phase = 'ANSWERING'; remaining = 10000;
  globalThis.fetch = () => new Promise(resolve => { pending = resolve; });
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  assert.equal(view.queryByRole('timer'), null);
  await act(async () => { pending!(Response.json(identity())); });
  assert.equal(view.getByRole('timer').textContent, '10');
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
  await act(async () => { live.emit('lobby:state', { room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
  assert.equal(view.queryByText(label), null);
});
