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

const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', state: 'ANSWERING', closedAt: null };
const timer = { serverNow: new Date(0).toISOString(), deadlineAt: new Date(30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false };
const question = { state: 'ANSWERING', questionId: 'q1', text: 'First question', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: true, optionId: 'a' }, timer };
const identity = { room, active: true, player: { id: 'p', name: 'Alice', language: 'en' }, game: question };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
function socket() {
  const live = Object.assign(new EventEmitter(), { connect() {}, disconnect() {} });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  return live;
}
function save() { dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' })); }

test('Player cleanup removes socket listeners and ignores an in-flight live refresh after remount', async () => {
  const live = socket(); save();
  const disconnect = mock.method(live, 'disconnect');
  globalThis.fetch = async () => Response.json(identity);
  const old = show('/play/ABCDE');
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  await act(async () => { live.emit('lobby:state', { room }); });
  old.unmount();
  assert.deepEqual(live.eventNames(), []);
  assert.equal(disconnect.mock.callCount(), 1);
  globalThis.fetch = async () => Response.json({ ...identity, game: { ...question, text: 'Current question' } });
  const current = show('/play/ABCDE');
  await waitFor(() => assert.ok(current.getByText('Current question')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  await act(async () => { finish(Response.json(identity)); });
  assert.equal(current.queryByText('First question'), null);
  assert.ok(current.getByText('Current question'));
  assert.equal(current.queryByRole('alert'), null);
});

for (const phase of ['ANSWERING', 'ANSWER_REVEAL']) test(`Player invalidates ${phase} content before a newer question authenticated refetch completes`, async () => {
  const live = socket(); save();
  const game = phase === 'ANSWER_REVEAL' ? { ...question, state: phase, correctOptionId: 'a', result: { outcome: 'correct', points: 1 } } : question;
  globalThis.fetch = async () => Response.json({ ...identity, room: { ...room, state: phase }, game });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('First question')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  const pending: ((response: Response) => void)[] = [];
  globalThis.fetch = () => new Promise(done => { pending.push(done); });
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' } }); });
  await act(async () => { live.emit('lobby:state', { room }); });
  assert.ok(!view.queryByText('First question'), 'previous question must disappear');
  assert.ok(!view.queryByRole('radio'), 'previous answer controls must disappear');
  assert.ok(!view.queryByText('Correct! +1'), 'previous reveal must disappear');
  assert.equal(pending.length, 2);
  await act(async () => { pending[1](Response.json({ ...identity, game: { ...question, questionId: 'q2', text: 'Second question', submission: { submitted: false } } })); });
  await act(async () => { pending[0](Response.json({ ...identity, room: { ...room, state: 'QUESTION' }, game: null })); });
  assert.ok(view.getByText('Second question'));
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, false);
});

for (const audience of ['host', 'screen']) test(`${audience} delayed initial HTTP cannot replace subscribed state or closure`, async () => {
  const live = socket();
  let resolve: (response: Response) => void = () => {};
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  const view = show(`/${audience}/room`);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'PAUSED' }, game: { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 12000 } }); });
  await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'closed' } }); });
  await act(async () => { resolve(Response.json({ room, game: { ...question, textRu: 'Старый', textEn: 'Old question', roundNumber: 1, questionNumber: 1, questionCount: 1 } })); });
  assert.ok(view.getByText(/Room closed/));
  assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByText('Old question'), null);
});

test('Player stale authenticated HTTP cannot restore an old answer after Pause and Resume', async () => {
  const live = socket(); save();
  globalThis.fetch = async () => Response.json(identity);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  const pending: ((response: Response) => void)[] = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  await act(async () => { live.emit('lobby:state', { room }); });
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'PAUSED' } }); });
  await act(async () => { live.emit('lobby:state', { room }); });
  await act(async () => { pending[2](Response.json({ ...identity, game: { ...question, text: 'Restored question', timer: { ...timer, remainingMs: 12000 } } })); });
  await act(async () => { pending[0](Response.json(identity)); pending[1](Response.json({ ...identity, room: { ...room, state: 'PAUSED' }, game: null })); });
  assert.ok(view.getByText('Restored question'));
  assert.ok(!view.queryByText('First question'), 'previous question must disappear');
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
});

test('Host Close requires confirmation and delayed action refresh cannot replace newer socket closure', async () => {
  const live = socket();
  let confirmed = false;
  const confirmations: string[] = [];
  mock.method(dom.window, 'confirm', (message: string) => { confirmations.push(message); return confirmed; });
  let resolve: (response: Response) => void = () => {};
  let posts = 0;
  let reads = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ ...room, closedAt: 'closed' }); }
    if (++reads === 1) return Response.json({ room });
    return new Promise(done => { resolve = done; });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Close room' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Close room' })); });
  assert.equal(posts, 0);
  confirmed = true;
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Close room' })); });
  assert.equal(posts, 1); assert.equal(confirmations.length, 2);
  await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'closed' } }); });
  await act(async () => { resolve(Response.json({ room })); });
  assert.ok(view.getByText('Room closed')); assert.equal(view.queryByRole('button'), null);
});

const hostCases = [
  { state: 'LOBBY', game: null, buttons: ['Start Game', 'Close room'] },
  { state: 'ROUND_INTRO', game: { state: 'ROUND_INTRO', roundNumber: 1, questionCount: 2, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '' }, buttons: ['Pause', 'Start Round', 'Close room'] },
  { state: 'QUESTION', game: { ...question, state: 'QUESTION' }, buttons: ['Pause', 'Start Question', 'Close room'] },
  { state: 'ANSWERING', game: question, buttons: ['Pause', 'Close room'] },
  { state: 'PAUSED', game: { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 12000, reason: 'manual' }, buttons: ['Resume', 'Close room'] },
  { state: 'PAUSED', game: { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 12000, reason: 'player_disconnect', disconnectedPlayer: { id: 'p', name: 'Alice', present: true } }, buttons: ['Wait for Player', 'Continue Without Player', 'Close room'] },
  { state: 'ANSWER_REVEAL', game: { ...question, state: 'ANSWER_REVEAL', questionNumber: 1, questionCount: 2, statistics: { correct: 1, wrong: 0, unanswered: 0 }, nextAction: 'next' }, buttons: ['Pause', 'Next Question', 'Close room'] },
  ...(['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'] as const).map(state => ({ state, game: { state, roundNumber: 1, questionCount: 2, titleRu: 'Раунд', titleEn: 'Round', leaderboard: [{ playerId: 'p', displayName: 'Alice', totalPoints: 1, rank: 1 }], nextAction: state === 'ROUND_END' ? 'show-leaderboard' : state === 'LEADERBOARD' ? 'next-round' : state === 'FINAL_RESULTS' ? 'show-winner' : null }, buttons: state === 'ROUND_END' ? ['Pause', 'Show Leaderboard', 'Close room'] : state === 'LEADERBOARD' ? ['Pause', 'Next Round', 'Close room'] : state === 'FINAL_RESULTS' ? ['Pause', 'Show Winner', 'Close room'] : ['Close room'] })),
  { state: 'ANSWERING', closedAt: 'closed', game: question, buttons: [] },
];
for (const [index, scenario] of hostCases.entries()) test(`Host HTTP reload restores exact controls: ${scenario.state} case ${index}`, async () => {
  socket();
  globalThis.fetch = async () => Response.json({ room: { ...room, state: scenario.state, closedAt: 'closedAt' in scenario ? scenario.closedAt : null }, game: scenario.game, players: [{ id: 'p', name: 'Alice', language: 'en', joinedAt: 'now' }] });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText('Party')));
  assert.deepEqual(view.queryAllByRole('button').filter(button => !button.closest('.device-setup')).map(button => button.textContent).sort(), (['FINAL_RESULTS', 'WINNER_SCREEN'].includes(scenario.state) || ('closedAt' in scenario && scenario.closedAt) ? [...scenario.buttons] : ['Kick', ...scenario.buttons]).sort());
  const primary = view.container.querySelector('.host-primary-action');
  if (scenario.buttons.some(label => !['Pause', 'Close room', 'Continue Without Player'].includes(label))) {
    assert.ok(primary);
    assert.equal(view.getByRole('region', { name: 'Game controls' }).querySelector('button'), primary);
  }
  if (scenario.game && 'reason' in scenario.game && scenario.game.reason === 'player_disconnect') {
    assert.ok(view.getByText(/Alice is back/));
    assert.equal((view.getByRole('button', { name: 'Wait for Player' }) as HTMLButtonElement).disabled, false);
  }
});

for (const phase of ['ANSWERING', 'PAUSED']) test(`Screen refresh and repeated socket resubscribe retain ${phase} authoritative timer`, async () => {
  const live = socket();
  const subscriptions: unknown[] = [];
  const snapshot = { room: { ...room, state: phase }, game: phase === 'ANSWERING' ? { ...question, textRu: 'Вопрос', textEn: 'Question', roundNumber: 1, questionNumber: 1, questionCount: 2 } : { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 12000 } };
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => { assert.equal(init?.method, undefined); requests.push(String(url)); return Response.json(snapshot); };
  let view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('Party')));
  if (phase === 'ANSWERING') assert.equal(view.getByRole('timer').textContent, '30');
  else assert.equal(view.queryByRole('timer'), null);
  view.unmount(); view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('Party')));
  live.on('lobby:subscribe', payload => subscriptions.push(payload));
  await act(async () => { live.emit('connect'); live.emit('lobby:state', snapshot); live.emit('disconnect'); live.emit('connect'); live.emit('lobby:state', snapshot); });
  assert.deepEqual(subscriptions, [{ roomId: 'room', audience: 'screen' }, { roomId: 'room', audience: 'screen' }]);
  assert.deepEqual(requests, ['/api/rooms/room/game/screen', '/api/rooms/room/game/screen']);
  if (phase === 'ANSWERING') assert.equal(view.getByRole('timer').textContent, '30');
  else assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('button'), null);
});

for (const excluded of [false, true]) test(`Player refresh preserves authenticated identity and ${excluded ? 'exclusion' : 'accepted answer'} without joining`, async () => {
  socket(); save();
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url)); assert.equal(init?.body, JSON.stringify({ token: 'secret' }));
    return Response.json({ ...identity, game: { ...question, excluded, options: excluded ? [] : question.options, submission: excluded ? { submitted: false } : question.submission } });
  };
  let view = show('/play/ABCDE');
  const label = excluded ? 'This question continued without you' : 'Answer submitted';
  await waitFor(() => assert.ok(view.getByText(label)));
  view.unmount(); view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(label)));
  assert.ok(view.getByText('Alice'));
  assert.deepEqual(requests, ['/api/rooms/room/reconnect', '/api/rooms/room/reconnect']);
  if (excluded) assert.equal(view.queryByRole('radio'), null);
  else { assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true); assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true); }
});

test('Player retry reconnect cannot overwrite a newer socket-triggered question fetch', async () => {
  const live = socket(); save();
  globalThis.fetch = async () => Response.json(identity);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('First question')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  globalThis.fetch = async () => Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
  await act(async () => { live.emit('lobby:state', { room }); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry' })));
  let resolveRetry: (response: Response) => void = () => {};
  globalThis.fetch = () => new Promise(resolve => { resolveRetry = resolve; });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry' })); });
  globalThis.fetch = async () => Response.json({ ...identity, game: { ...question, questionId: 'q2', text: 'New question' } });
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' } }); });
  await act(async () => { live.emit('lobby:state', { room }); });
  assert.ok(view.getByText('New question'));
  await act(async () => { resolveRetry(Response.json(identity)); });
  assert.ok(!view.queryByText('First question'), 'stale retry must not replace the newer question');
  assert.ok(view.getByText('New question'));
});

for (const [scenarioIndex, label] of [[1, 'Start Round'], [4, 'Resume']] as const) test(`Host routine ${label} sends intent without confirmation`, async () => {
  socket();
  mock.method(dom.window, 'confirm', () => { throw new Error('Routine controls must not request confirmation'); });
  const scenario = hostCases[scenarioIndex];
  const commands: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') commands.push(String(url).split('/').at(-1)!);
    return Response.json({ room: { ...room, state: scenario.state }, game: scenario.game });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: label })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: label })); });
  assert.deepEqual(commands, [label === 'Resume' ? 'resume' : 'start-round']);
  assert.equal(view.queryByRole('alert'), null);
});

test('Host Kick requires confirmation, sends permanent removal intent, and updates roster', async () => {
  const live = socket(); let confirmed = false, posts = 0;
  mock.method(dom.window, 'confirm', () => confirmed);
  let snapshot: unknown = { room: { ...room, state: 'LOBBY' }, players: [{ id: 'p', name: 'Alice', language: 'en', joinedAt: 'now', present: true }] };
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), '/api/rooms/room/players/p/kick');
      assert.deepEqual(JSON.parse(String(init.body)), { confirmed: true }); posts++;
      snapshot = { room: { ...room, state: 'LOBBY' }, players: [] };
    }
    return Response.json(snapshot);
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText(/Alice — EN — Online/)));
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Kick Alice' })));
  assert.equal(posts, 0);
  confirmed = true;
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Kick Alice' })));
  assert.equal(posts, 1);
  assert.ok(view.getByText(/No players/));
  assert.equal(view.queryByRole('button', { name: 'Kick Alice' }), null);
  await act(async () => live.emit('lobby:state', snapshot));
});

test('Kicked Player loses active answer controls and stale reconnect cannot restore them', async () => {
  const live = socket(); save();
  globalThis.fetch = async () => Response.json(identity);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  let resolve!: (response: Response) => void;
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  await act(async () => live.emit('lobby:state', { room }));
  await act(async () => live.emit('player:removed', { roomId: room.id }));
  await act(async () => resolve(Response.json(identity)));
  assert.ok(view.getByText('The host removed you from the game.'));
  assert.equal(view.queryByRole('radio'), null);
  assert.equal(view.queryByRole('button', { name: 'Submit' }), null);
  assert.equal(view.queryByLabelText('Player language'), null);
});
