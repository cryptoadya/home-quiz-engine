import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanup, render, waitFor, act, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const room = { id: 'room', code: 'ABCDE', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
function socket() {
  const events = new EventEmitter();
  const transport = Object.assign(events, { disconnect() {}, connect() {} });
  mock.method(lobbyTransport, 'connect', () => transport as unknown as Socket);
  return transport;
}

test('Host loads roster, applies realtime snapshots and resubscribes for authoritative recovery', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json({ room, players: [player] });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText(/Alex/)));
  assert.ok(view.getByText(/EN/));
  assert.ok(view.getByText(/Players: 1/));
  live.on('lobby:subscribe', input => {
    assert.deepEqual(input, { roomId: 'room', audience: 'host' });
    live.emit('lobby:state', { room, players: [player, { ...player, id: 'two', name: 'Jane' }] });
  });
  await act(async () => { live.emit('connect'); });
  assert.ok(view.getByText(/Jane/));
  await act(async () => { live.emit('disconnect'); });
  assert.ok(view.getByText('Reconnecting…'));
  live.removeAllListeners('lobby:subscribe');
  live.on('lobby:subscribe', () => live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }));
  await act(async () => { live.emit('connect'); });
  assert.ok(view.getByText('Room closed'));
});

test('Screen renders count, same-room bilingual QR links, LAN origin and live closure', async () => {
  dom.reconfigure({ url: 'http://192.168.1.50:5173/screen/room' });
  try {
    const live = socket();
    globalThis.fetch = async () => Response.json({ room, players: [player] });
    const view = show('/screen/room');
    await waitFor(() => assert.ok(view.getByText('ABCDE')));
    assert.ok(view.getByText(/Players: 1/));
    for (const lang of ['ru', 'en']) {
      const link = view.getByRole('link', { name: lang.toUpperCase() }) as HTMLAnchorElement;
      assert.equal(link.href, `http://192.168.1.50:5173/play/ABCDE?lang=${lang}`);
      assert.ok(link.querySelector('svg'));
    }
    await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }); });
    assert.ok(view.getByText(/Room closed/));
    assert.equal(view.queryByRole('link', { name: 'RU' }), null);
  } finally { dom.reconfigure({ url: 'http://localhost' }); }
});

test('query preference initializes language and restored Player reacts to live closure without roster', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json(room);
  let view = show('/play/ABCDE?lang=en');
  await waitFor(() => assert.ok(view.getByLabelText('Language')));
  assert.equal((view.getByLabelText('Language') as HTMLSelectElement).value, 'en');
  view.unmount();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room, player, active: true });
  view = show('/play/ABCDE?lang=ru');
  await waitFor(() => assert.ok(view.getByText('Waiting for the host…')));
  live.on('lobby:subscribe', input => assert.deepEqual(input, { roomId: 'room', audience: 'player' }));
  await act(async () => { live.emit('connect'); live.emit('lobby:state', { room: { ...room, closedAt: 'now' } }); });
  assert.ok(view.getByText('Room closed'));
});

test('a delayed initial HTTP response cannot overwrite a newer socket snapshot', async () => {
  const live = socket();
  let finish!: (value: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const view = show('/host/room');
  await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }); });
  await act(async () => { finish(Response.json({ room, players: [] })); });
  assert.ok(view.getByText('Room closed'));
  assert.ok(view.getByText(/Alex/));
});

test('localhost Screen warns about phone reachability', async () => {
  socket();
  globalThis.fetch = async () => Response.json({ room, players: [] });
  const view = show('/screen/room');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /LAN address/));
});


test('Host requires players and confirmation; Start success removes control and updates state', async () => {
  const live = socket();
  let starts = 0;
  let confirmed = false;
  mock.method(window, 'confirm', (message: string) => {
    assert.match(message, /player list and quiz content will be locked/i);
    return confirmed;
  });
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), '/api/rooms/room/start');
      starts++;
      return Response.json({ ...room, state: 'ROUND_INTRO' });
    }
    return Response.json({ room, players: [] });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText(/Players: 0/)));
  assert.equal(view.queryByRole('button', { name: 'Start Game' }), null);
  await act(async () => { live.emit('lobby:state', { room, players: [player] }); });
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  assert.equal(starts, 0);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  await waitFor(() => assert.ok(view.getByText('Round Intro')));
  assert.equal(starts, 1);
  assert.equal(view.queryByRole('button', { name: 'Start Game' }), null);
});

test('Host keeps Start failure visible when a realtime snapshot arrives', async () => {
  const live = socket();
  mock.method(window, 'confirm', () => true);
  globalThis.fetch = async (_url, init) => init?.method === 'POST'
    ? Response.json({ error: 'Quiz is not ready. Review the validation problems.' }, { status: 409 })
    : Response.json({ room, players: [player] });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Start Game' })));
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Quiz is not ready/));
  await act(async () => { live.emit('lobby:state', { room, players: [player] }); });
  assert.match(view.getByRole('alert').textContent!, /Quiz is not ready/);
});

test('Screen leaves QR and join instructions when Start is broadcast and on reload', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json({ room, players: [player] });
  let view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'RU' })));
  const started = { room: { ...room, state: 'ROUND_INTRO', quizTitle: 'Frozen title' }, players: [player] };
  await act(async () => { live.emit('lobby:state', started); });
  assert.ok(view.getByText(/Game starting/));
  assert.equal(view.queryByRole('link', { name: 'RU' }), null);
  assert.equal(view.queryByText(/scan a QR/), null);
  assert.equal(view.container.querySelector('svg'), null);
  view.unmount();
  globalThis.fetch = async () => Response.json(started);
  view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText(/Game starting/)));
  assert.ok(view.getByText('Frozen title'));
  assert.equal(view.container.querySelector('svg'), null);
});

for (const language of ['ru', 'en']) test(`Player ${language} leaves waiting on Start and restores starting state`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room, player: { ...player, language }, active: true });
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Ожидайте ведущего…' : 'Waiting for the host…')));
  const started = { ...room, state: 'ROUND_INTRO' };
  await act(async () => { live.emit('lobby:state', { room: started }); });
  assert.ok(view.getByText(language === 'ru' ? 'Игра начинается…' : 'Game is starting…'));
  view.unmount();
  globalThis.fetch = async () => Response.json({ room: started, player: { ...player, language }, active: true });
  view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Игра начинается…' : 'Game is starting…')));
});

test('direct code identifies a started game and does not offer joining', async () => {
  socket();
  globalThis.fetch = async () => Response.json({ ...room, state: 'ROUND_INTRO' });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /started|accepting players/i));
  assert.equal(view.queryByRole('button', { name: 'Join' }), null);
});
