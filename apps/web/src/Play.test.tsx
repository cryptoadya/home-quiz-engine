import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { lobbyTransport } from './lobby';

const room = { id: 'room', code: 'ABCDE', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const key = 'quiz-player:ABCDE';
const saved = JSON.stringify({ roomId: 'room', token: 'secret' });
const originalFetch = globalThis.fetch;
const originalFormData = globalThis.FormData;
globalThis.FormData = dom.window.FormData;
after(() => { globalThis.FormData = originalFormData; });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
beforeEach(() => {
  // HTTP-focused tests must not open real sockets or schedule network retries.
  mock.method(lobbyTransport, 'connect', () => Object.assign(new EventEmitter(), { connect() {}, disconnect() {} }) as unknown as Socket);
});
afterEach(() => { cleanup(); mock.restoreAll(); dom.window.localStorage.clear(); globalThis.fetch = originalFetch; });

test('/play finds a room, offers RU/EN, saves identity and enters the waiting state', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/rooms/code/ABCDE') return Response.json(room);
    assert.equal(String(url), '/api/rooms/code/ABCDE/players');
    assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Alex', language: 'en' });
    return Response.json({ room, player, active: true, token: 'secret' }, { status: 201 });
  };
  const view = show('/play');
  fireEvent.change(view.getByLabelText('Room code'), { target: { value: 'abcde' } });
  fireEvent.click(view.getByRole('button', { name: 'Find room' }));
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.ok(view.getByRole('option', { name: 'RU' }));
  assert.ok(view.getByRole('option', { name: 'EN' }));
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Alex' } });
  fireEvent.change(view.getByLabelText('Language'), { target: { value: 'en' } });
  fireEvent.click(view.getByRole('button', { name: 'Join' }));
  await waitFor(() => assert.match(view.getByRole('status').textContent!, /Waiting for the host/));
  assert.equal(dom.window.localStorage.getItem(key), saved);
  assert.ok(view.getByText('Alex'));
  assert.ok(!view.queryByLabelText('Player language'), 'Language belongs inside closed Settings');
  assert.ok(!view.queryByLabelText('New player name'), 'Rename belongs inside closed Settings');
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  assert.ok(view.getByLabelText('Player language'));
  assert.ok(view.getByLabelText('New player name'));
});

test('direct code flow prefills the room and shows duplicate-name errors', async () => {
  globalThis.fetch = async (_url, init) => init?.method === 'POST'
    ? Response.json({ error: 'That name is already taken in this room.' }, { status: 409 }) : Response.json(room);
  const view = show('/play/abcde');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.ok(view.getByDisplayValue('ABCDE'));
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Alex' } });
  fireEvent.click(view.getByRole('button', { name: 'Join' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /already taken/));
  assert.equal(dom.window.localStorage.getItem(key), null);
});

test('active stored identity restores waiting state without looking up the code or joining', async () => {
  dom.window.localStorage.setItem(key, saved);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/rooms/room/reconnect');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: 'secret' });
    return Response.json({ player, room, active: true });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('status').textContent!, /Waiting for the host/));
  assert.equal(view.queryByLabelText('Name'), null);
  assert.equal(dom.window.localStorage.getItem(key), saved);
});

for (const status of [401, 404]) test(`revoked or missing saved reconnect (${status}) is cleared and falls back to join form`, async () => {
  dom.window.localStorage.setItem(key, saved);
  dom.window.localStorage.setItem('quiz-player:FGHJK', 'other-room');
  globalThis.fetch = async (url) => String(url).endsWith('/reconnect')
    ? Response.json({ error: 'Invalid player reconnect token.' }, { status }) : Response.json(room);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.equal(dom.window.localStorage.getItem(key), null);
  assert.equal(dom.window.localStorage.getItem('quiz-player:FGHJK'), 'other-room');
});

for (const stale of [
  { closedAt: 'closed', active: false },
  { closedAt: 'closed', active: true },
  { closedAt: null, active: false },
]) test(`stale reconnect ${JSON.stringify(stale)} resolves reused code and replaces identity only after joining`, async () => {
  dom.window.localStorage.setItem(key, saved);
  const newRoom = { ...room, id: 'new-room', quizTitle: 'New party' };
  const newPlayer = { ...player, id: 'new-player', name: 'Sam' };
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    requests.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === '/api/rooms/room/reconnect') return Response.json({ player, room: { ...room, closedAt: stale.closedAt }, active: stale.active });
    if (path === '/api/rooms/code/ABCDE') return Response.json(newRoom);
    if (path === '/api/rooms/code/ABCDE/players') return Response.json({ room: newRoom, player: newPlayer, active: true, token: 'new-secret' }, { status: 201 });
    if (path === '/api/rooms/new-room/player') return Response.json({ room: newRoom, player: { ...newPlayer, language: 'ru' }, active: true });
    throw new Error(`Unexpected request: ${path}`);
  };
  const view = show('/play/ABCDE?lang=en');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.ok(view.getByText('New party'));
  assert.equal(view.queryByText('Alex'), null);
  assert.equal(dom.window.localStorage.getItem(key), null);
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Sam' } });
  fireEvent.click(view.getByRole('button', { name: 'Join' }));
  await waitFor(() => assert.match(view.getByRole('status').textContent!, /Waiting for the host/));
  assert.ok(view.getByText('Sam'));
  assert.equal(dom.window.localStorage.getItem(key), JSON.stringify({ roomId: 'new-room', token: 'new-secret' }));
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await waitFor(() => assert.match(view.getByRole('status').textContent!, /Ожидайте ведущего/));
  assert.deepEqual(requests, [
    { url: '/api/rooms/room/reconnect', body: { token: 'secret' } },
    { url: '/api/rooms/code/ABCDE', body: null },
    { url: '/api/rooms/code/ABCDE/players', body: { name: 'Sam', language: 'en' } },
    { url: '/api/rooms/new-room/player', body: { token: 'new-secret', language: 'ru' } },
  ]);
});

for (const destination of ['missing', 'started', 'closed']) test(`closed saved room with ${destination} code destination does not offer a false join or active session`, async () => {
  dom.window.localStorage.setItem(key, saved);
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/rooms/room/reconnect') return Response.json({ player, room: { ...room, closedAt: 'closed' }, active: false });
    assert.equal(String(url), '/api/rooms/code/ABCDE');
    return destination === 'missing'
      ? Response.json({ error: 'Active room not found.' }, { status: 404 })
      : Response.json({ ...room, id: 'new-room', state: destination === 'started' ? 'ANSWERING' : 'LOBBY', closedAt: destination === 'closed' ? 'closed' : null });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /not found|no longer accepting players/));
  assert.equal(view.queryByLabelText('Name'), null);
  assert.equal(view.queryByLabelText('Player language'), null);
  assert.equal(view.queryByText('Alex'), null);
  assert.equal(dom.window.localStorage.getItem(key), null);
});

test('active started-game reconnect restores gameplay and accepted answer without code lookup', async () => {
  dom.window.localStorage.setItem(key, saved);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/rooms/room/reconnect');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: 'secret' });
    return Response.json({ player, room: { ...room, state: 'ANSWERING' }, active: true, game: {
      state: 'ANSWERING', questionId: 'q1', text: 'Pick a fruit', options: [{ id: 'a', text: 'Apple' }],
      submission: { submitted: true, optionId: 'a' },
      timer: { serverNow: new Date(0).toISOString(), deadlineAt: new Date(30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false },
    } });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  assert.ok(view.getByText('Pick a fruit'));
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
  assert.equal(view.queryByLabelText('Name'), null);
  assert.equal(dom.window.localStorage.getItem(key), saved);
});

test('temporary reconnect failure retains token and blocks a second join until retry succeeds', async () => {
  dom.window.localStorage.setItem(key, saved);
  let fail = true;
  globalThis.fetch = async () => {
    if (fail) throw new Error('Network unavailable');
    return Response.json({ player, room, active: true });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Network unavailable/));
  assert.equal(dom.window.localStorage.getItem(key), saved);
  assert.equal(view.queryByLabelText('Name'), null);
  fail = false;
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  await waitFor(() => assert.match(view.getByRole('status').textContent!, /Waiting for the host/));
});

for (const themeId of ['default', 'halloween']) for (const state of ['LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED']) test(`Player keeps language secondary in Settings (${themeId}, ${state})`, async () => {
  dom.window.localStorage.setItem(key, saved);
  const gameRoom = { ...room, themeId, state };
  let language = 'en';
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH') {
      assert.equal(String(url), '/api/rooms/room/player');
      assert.deepEqual(JSON.parse(String(init.body)), { token: 'secret', language: 'ru' });
      language = 'ru';
    }
    return Response.json({ room: gameRoom, player: { ...player, language }, active: true });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Alex')));
  const header = view.container.querySelector('header')!;
  assert.equal(header.querySelector('h2')?.textContent, 'Party');
  assert.match(header.textContent!, /ABCDE/);
  assert.match(header.textContent!, /Alex/);
  assert.equal(view.queryByLabelText('Player language'), null);
  assert.equal(view.queryByLabelText('New player name'), null);
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  assert.ok(header.contains(view.getByLabelText('Player language')));
  assert.equal(Boolean(view.queryByLabelText('New player name')), state === 'LOBBY');
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Настройки', expanded: false })));
  assert.equal(view.queryByLabelText('Player language'), null);
  assert.equal(dom.window.localStorage.getItem(key), saved);
  assert.match(header.textContent!, /ABCDE/);
  assert.match(header.textContent!, /Alex/);
});

test('Settings switches current content, preserves draft and accepted lock, and restores server language on reconnect', async () => {
  dom.window.localStorage.setItem(key, saved);
  let language = 'en';
  let submitted = false;
  let submits = 0;
  const gameRoom = { ...room, state: 'ANSWERING' };
  const timer = { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/answers')) {
      submits++;
      submitted = true;
      return Response.json({ submitted: true, optionId: 'a' });
    }
    if (init?.method === 'PATCH') {
      assert.equal(String(url), '/api/rooms/room/player');
      const body = JSON.parse(String(init.body));
      assert.equal(body.token, 'secret');
      language = body.language;
    } else assert.equal(String(url), '/api/rooms/room/reconnect');
    return Response.json({ player: { ...player, language }, room: gameRoom, active: true, game: {
      state: 'ANSWERING', questionId: 'q1', text: language === 'en' ? 'Pick a fruit' : 'Выберите фрукт',
      options: [{ id: 'a', text: language === 'en' ? 'Apple' : 'Яблоко' }], timer,
      // A stale PATCH projection must not unlock a locally acknowledged answer.
      submission: { submitted: init?.method !== 'PATCH' && submitted, optionId: 'a' },
    } });
  };
  let view = show('/play/ABCDE?lang=ru');
  await waitFor(() => assert.ok(view.getByText('Pick a fruit')));
  fireEvent.click(view.getByRole('radio'));
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await waitFor(() => assert.ok(view.getByText('Выберите фрукт')));
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal(view.queryByLabelText('Player language'), null);
  fireEvent.click(view.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => assert.ok(view.getByText('Ответ принят')));
  fireEvent.click(view.getByRole('button', { name: 'Настройки' }));
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'en' } });
  await waitFor(() => assert.ok(view.getByText('Pick a fruit')));
  assert.ok(view.getByText('Answer submitted'));
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
  fireEvent.submit(view.getByRole('button', { name: 'Submit' }).closest('form')!);
  assert.equal(submits, 1);
  view.unmount(); view = show('/play/ABCDE?lang=ru');
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  assert.ok(view.getByText('Pick a fruit'));
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await waitFor(() => assert.ok(view.getByText('Ответ принят')));
  view.unmount(); view = show('/play/ABCDE?lang=en');
  await waitFor(() => assert.ok(view.getByText('Ответ принят')));
  assert.ok(view.getByText('Яблоко'));
  assert.equal((view.getByRole('button', { name: 'Отправить' }) as HTMLButtonElement).disabled, true);
  assert.equal(dom.window.localStorage.getItem(key), saved);
});

test('Lobby rename remains available inside Settings', async () => {
  dom.window.localStorage.setItem(key, saved);
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PATCH') {
      assert.deepEqual(JSON.parse(String(init.body)), { token: 'secret', name: 'Sam' });
      return Response.json({ player: { ...player, name: 'Sam' }, room, active: true });
    }
    return Response.json({ player, room, active: true });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Alex')));
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  fireEvent.change(view.getByLabelText('New player name'), { target: { value: 'Sam' } });
  fireEvent.click(view.getByRole('button', { name: 'Rename' }));
  await waitFor(() => assert.ok(view.getByText('Sam')));
  assert.equal(view.queryByLabelText('New player name'), null);
});

test('removal while Settings update is pending cannot restore player controls', async () => {
  dom.window.localStorage.setItem(key, saved);
  const socket = new EventEmitter();
  mock.method(lobbyTransport, 'connect', () => Object.assign(socket, { connect() {}, disconnect() {} }) as unknown as Socket);
  let resolve!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => init?.method === 'PATCH'
    ? new Promise<Response>(done => { resolve = done; })
    : Response.json({ player, room, active: true });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Alex')));
  fireEvent.click(view.getByRole('button', { name: 'Settings' }));
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await act(async () => { socket.emit('player:removed', { roomId: room.id }); });
  await act(async () => { resolve(Response.json({ player: { ...player, language: 'ru' }, room, active: true })); });
  assert.ok(view.getByText('The host removed you from the game.'));
  assert.equal(view.queryByRole('button', { name: /Settings|Настройки/ }), null);
  assert.equal(view.queryByLabelText('Player language'), null);
});

for (const outcome of ['revoked', 'network-error'] as const) test(`unmounted reconnect ${outcome} cannot clear a newer identity or start a code lookup`, async () => {
  dom.window.localStorage.setItem(key, saved);
  let resolve!: (response: Response) => void;
  let reject!: (cause: Error) => void;
  globalThis.fetch = () => new Promise((done, fail) => { resolve = done; reject = fail; });
  const old = show('/play/ABCDE');
  old.unmount();
  const replacement = JSON.stringify({ roomId: 'new-room', token: 'new-secret' });
  dom.window.localStorage.setItem(key, replacement);
  const requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return Response.json({ room: { ...room, id: 'new-room' }, player: { ...player, name: 'Sam' }, active: true });
  };
  const current = show('/play/ABCDE');
  await waitFor(() => assert.ok(current.getByText('Sam')));
  await act(async () => {
    if (outcome === 'revoked') resolve(Response.json({ error: 'Revoked' }, { status: 401 }));
    else reject(new Error('Late network error'));
  });
  assert.deepEqual(requests, ['/api/rooms/new-room/reconnect']);
  assert.equal(dom.window.localStorage.getItem(key), replacement);
  assert.ok(current.getByText('Sam'));
  assert.equal(current.queryByRole('alert'), null);
  assert.equal(current.queryByLabelText('Name'), null);
});

test('Player can find and join a lobby when browser storage access is denied', async () => {
  mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new Error('Storage denied'); });
  globalThis.fetch = async (_url, init) => Response.json(init?.method === 'POST'
    ? { room, player, active: true, token: 'secret' } : room);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Alex' } });
  fireEvent.click(view.getByRole('button', { name: 'Join' }));
  await waitFor(() => assert.ok(view.getByText('Waiting for the host…')));
});

test('Player ignores a failed removal of corrupt storage and still resolves the current lobby', async () => {
  dom.window.localStorage.setItem(key, '{broken');
  mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new Error('Storage denied'); });
  globalThis.fetch = async () => Response.json(room);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
});
