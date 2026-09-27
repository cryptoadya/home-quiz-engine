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
    await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
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

for (const audience of ['host', 'screen']) test(`${audience} disconnect pause renders the appropriate private/public resolution controls`, async () => {
  const live = socket();
  const snapshot = { ...paused, game: { ...paused.game, reason: 'player_disconnect', disconnectedPlayer: { id: 'a', name: 'Alice' } } };
  globalThis.fetch = async () => Response.json({ room, game: question });
  const view = show(`/${audience}/room`);
  await waitFor(() => assert.ok(view.getByText('Party')));
  await act(async () => { live.emit('lobby:state', snapshot); });
  if (audience === 'host') {
    assert.ok(view.getByText('Alice disconnected.'));
    assert.ok(view.getByText('Game paused.'));
    assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), ['Wait for Player', 'Continue Without Player', 'Close room']);
    assert.equal((view.getByRole('button', { name: 'Wait for Player' }) as HTMLButtonElement).disabled, true);
  } else {
    assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
    assert.equal(view.queryByText(/Alice/), null);
    assert.equal(view.queryByRole('button'), null);
  }
});

test('Player authenticates every socket reconnect, exposes subscription failure and retains durable identity', async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room: paused.room, active: true, player: { id: 'a', name: 'Alice', language: 'en' }, game: null });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Paused')));
  const subscriptions: unknown[] = [];
  live.on('lobby:subscribe', input => subscriptions.push(input));
  await act(async () => { live.emit('connect'); live.emit('lobby:error', { error: 'Invalid player reconnect token.' }); });
  assert.match(view.getByRole('alert').textContent!, /Invalid player reconnect token.*Reload/);
  assert.ok(dom.window.localStorage.getItem('quiz-player:ABCDE'));
  await act(async () => { live.emit('disconnect'); live.emit('connect'); live.emit('lobby:state', { room: paused.room }); });
  assert.deepEqual(subscriptions, [{ roomId: 'room', audience: 'player', token: 'secret' }, { roomId: 'room', audience: 'player', token: 'secret' }]);
  assert.equal(view.queryByRole('alert'), null);
  assert.ok(view.getByText('Paused')); assert.equal(view.queryByRole('radio'), null);
});

test('accepted Player answer survives socket disconnect without displaying an invented Pause', async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ANSWERING' }, active: true, player: { id: 'a', name: 'Alice', language: 'en' },
    game: { state: 'ANSWERING', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: true, optionId: 'a' }, timer: timer(Date.now(), 30000) } });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByRole('radio')));
  await act(async () => { live.emit('disconnect'); });
  assert.equal(view.queryByText('Paused'), null);
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
});

test('Host reconnect enables Wait without confirmation and resumes; Continue requires explicit confirmation', async () => {
  const live = socket();
  const disconnect = (present: boolean) => ({ ...paused, game: { ...paused.game, reason: 'player_disconnect', disconnectedPlayer: { id: 'a', name: 'Alice', present } } });
  let snapshot: unknown = disconnect(false);
  const commands: string[] = [];
  const confirmations: string[] = [];
  let confirm = false;
  mock.method(dom.window, 'confirm', (message: string) => { confirmations.push(String(message)); return confirm; });
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      commands.push(String(url).split('/').at(-1)!);
      snapshot = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(Date.now(), 10000) } };
    }
    return Response.json(snapshot);
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Wait for Player' })));
  assert.equal((view.getByRole('button', { name: 'Wait for Player' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByRole('button', { name: 'Resume' }), null);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Continue Without Player' })); });
  assert.deepEqual(commands, []);
  assert.match(confirmations[0], /Continue without Alice.*0 points for this question.*return for the next question/);
  snapshot = disconnect(true);
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.ok(view.getByText(/Alice is back/));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Wait for Player' })); });
  assert.deepEqual(commands, ['wait-for-player']); assert.equal(confirmations.length, 1);
  assert.equal(view.getByRole('timer').textContent, '10');
  snapshot = disconnect(false);
  await act(async () => { live.emit('lobby:state', snapshot); });
  confirm = true;
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Continue Without Player' })); });
  assert.deepEqual(commands, ['wait-for-player', 'continue-without-player']);
  assert.ok(view.getByRole('button', { name: 'Pause' }));
});

for (const language of ['ru', 'en']) test(`excluded Player ${language} has no controls and next question restores them`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let excluded = true;
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ANSWERING' }, active: true, player: { id: 'a', name: 'Alice', language },
    game: { state: 'ANSWERING', questionId: excluded ? 'q1' : 'q2', excluded, text: 'Pick', options: excluded ? [] : [{ id: 'a', text: 'Apple' }], submission: { submitted: false }, timer: timer(Date.now(), 10000) } });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Этот вопрос продолжен без вас' : 'This question continued without you')));
  assert.equal(view.queryByRole('radio'), null); assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('button', { name: /Submit|Отправить/ }), null);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' } }); });
  excluded = false;
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' } }); });
  await waitFor(() => assert.ok(view.getByRole('radio')));
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, false);
});
