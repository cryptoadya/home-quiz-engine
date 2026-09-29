import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

const room = { id: 'room', code: 'ABCDE', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const key = 'quiz-player:ABCDE';
const saved = JSON.stringify({ roomId: 'room', token: 'secret' });
const originalFetch = globalThis.fetch;
const originalFormData = globalThis.FormData;
globalThis.FormData = dom.window.FormData;
after(() => { globalThis.FormData = originalFormData; });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
afterEach(() => { cleanup(); dom.window.localStorage.clear(); globalThis.fetch = originalFetch; });

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

for (const closed of [false, true]) test(`stored identity restores ${closed ? 'closed' : 'waiting'} state without joining`, async () => {
  dom.window.localStorage.setItem(key, saved);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/rooms/room/reconnect');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: 'secret' });
    return Response.json({ player, room: { ...room, closedAt: closed ? 'now' : null }, active: !closed });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('status').textContent!, closed ? /Room closed/ : /Waiting for the host/));
  assert.equal(view.queryByLabelText('Name'), null);
  assert.equal(dom.window.localStorage.getItem(key), saved);
});

test('invalid stored token is cleared and direct flow falls back to join form', async () => {
  dom.window.localStorage.setItem(key, saved);
  dom.window.localStorage.setItem('quiz-player:FGHJK', 'other-room');
  globalThis.fetch = async (url) => String(url).endsWith('/reconnect')
    ? Response.json({ error: 'Invalid player reconnect token.' }, { status: 401 }) : Response.json(room);
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.equal(dom.window.localStorage.getItem(key), null);
  assert.equal(dom.window.localStorage.getItem('quiz-player:FGHJK'), 'other-room');
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

for (const themeId of ['default', 'halloween']) test(`gameplay header keeps identity and live language switching together (${themeId})`, async () => {
  dom.window.localStorage.setItem(key, saved);
  const gameRoom = { ...room, themeId, state: 'QUESTION' };
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
  await waitFor(() => assert.ok(view.getByText('Get ready for the question')));
  const header = view.container.querySelector('header')!;
  assert.equal(header.querySelector('h2')?.textContent, 'Party');
  assert.match(header.textContent!, /ABCDE/);
  assert.match(header.textContent!, /Alex/);
  assert.ok(header.contains(view.getByLabelText('Player language')));
  assert.equal(view.queryByLabelText('New player name'), null);
  fireEvent.change(view.getByLabelText('Player language'), { target: { value: 'ru' } });
  await waitFor(() => assert.ok(view.getByText('Приготовьтесь к вопросу')));
  assert.equal((view.getByLabelText('Player language') as HTMLSelectElement).value, 'ru');
  assert.equal(dom.window.localStorage.getItem(key), saved);
  assert.match(header.textContent!, /ABCDE/);
  assert.match(header.textContent!, /Alex/);
});
