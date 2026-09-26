import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanup, render, waitFor, act } from '@testing-library/react';
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
