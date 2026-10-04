import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const room = { id: 'bf005061-5712-4440-aa3c-93c58683ef40', code: 'H8VXT', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); dom.reconfigure({ url: 'http://localhost' }); });
function Location() { return createElement('output', { 'aria-label': 'Current route' }, useLocation().pathname); }
function show(path: string) {
  mock.method(lobbyTransport, 'connect', () => Object.assign(new EventEmitter(), { connect() {}, disconnect() {} }) as unknown as Socket);
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App), createElement(Location)));
}
function serve(active = room) {
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/rooms/code/H8VXT') {
      assert.equal(init?.cache, 'no-store');
      return Response.json(active);
    }
    if (String(url) === `/api/rooms/${active.id}/game/host` || String(url) === `/api/rooms/${active.id}/game/screen`) return Response.json({ room: active, players: [] });
    if (String(url) === '/api/network') return Response.json({ addresses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
}

for (const destination of ['host', 'screen']) {
  test(`${destination} code route resolves internally and keeps a human-readable URL`, async () => {
    serve();
    const view = show(`/${destination}/H8VXT`);
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.ok(view.getByText('H8VXT'));
    assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/H8VXT`);
  });
  test(`${destination} entry normalizes lowercase codes and opens the code route`, async () => {
    serve();
    const view = show(`/${destination}`);
    assert.equal(view.queryByText(/UUID/), null);
    fireEvent.change(view.getByLabelText('Room code'), { target: { value: ' h8vxt ' } });
    fireEvent.click(view.getByRole('button', { name: `Open ${destination === 'host' ? 'Host' : 'Screen'}` }));
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/H8VXT`);
  });
  test(`${destination} lowercase path normalizes to the code route`, async () => {
    serve();
    const view = show(`/${destination}/h8vxt`);
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/H8VXT`);
  });
  test(`${destination} code reuse opens the current room; UUID still opens its own session`, async () => {
    serve();
    let view = show(`/${destination}/H8VXT`);
    await waitFor(() => assert.ok(view.getByText('Party')));
    view.unmount();
    serve({ ...room, id: 'replacement-uuid', quizTitle: 'New party' });
    view = show(`/${destination}/H8VXT`);
    await waitFor(() => assert.ok(view.getByText('New party')));
    view.unmount();
    serve();
    view = show(`/${destination}/${room.id}`);
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/${room.id}`);
  });
  for (const closed of [false, true]) test(`${destination} reports ${closed ? 'closed' : 'nonexistent'} code clearly`, async () => {
    globalThis.fetch = async () => closed ? Response.json({ ...room, closedAt: 'now' }) : Response.json({ error: 'Active room not found.' }, { status: 404 });
    const view = show(`/${destination}/H8VXT`);
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, /not found|closed/i));
    assert.equal(view.queryByText('Party'), null);
  });
}

test('Host Lobby shows its code and controls without organizer sharing or network UI', async () => {
  serve();
  const view = show(`/host/${room.id}`);
  await waitFor(() => assert.ok(view.getByText('H8VXT')));
  assert.ok(view.getByRole('button', { name: 'Закрыть комнату' }));
  assert.equal(view.container.querySelector('svg'), null);
  assert.equal(view.queryByRole('region', { name: /Device setup/ }), null);
  assert.equal(view.queryByLabelText('Network address'), null);
  assert.equal(view.queryByRole('button', { name: /Copy/ }), null);
  assert.equal(view.queryByRole('textbox'), null);
  assert.equal(view.queryByRole('link', { name: /Open Host|Open Screen/ }), null);
});

test('Screen selects the single usable private LAN address, excludes link-local and preserves port', async () => {
  dom.reconfigure({ url: 'http://localhost:5180' });
  globalThis.fetch = async url => Response.json(String(url) === '/api/network' ? { addresses: [
    { name: 'loopback', address: '127.0.0.2' }, { name: 'link-local', address: '169.254.59.101' },
    { name: 'unspecified', address: '0.0.0.0' }, { name: 'public', address: '8.8.8.8' },
    { name: 'Wi-Fi', address: '192.168.178.37' }, { name: 'duplicate', address: '192.168.178.37' },
  ] } : { room, players: [] });
  const view = show(`/screen/${room.id}`);
  await waitFor(() => assert.equal((view.getByRole('link', { name: 'Players / Игроки' }) as HTMLAnchorElement).href, 'http://192.168.178.37:5180/play/H8VXT'));
  assert.equal(view.container.querySelectorAll('svg').length, 1);
  assert.equal(view.queryByLabelText('Party network'), null);
});

test('localhost Screen offers a compact choice only when multiple private addresses exist', async () => {
  dom.reconfigure({ url: 'http://localhost:5173' });
  globalThis.fetch = async url => Response.json(String(url) === '/api/network' ? { addresses: [
    { name: 'Wi-Fi', address: '192.168.178.37' }, { name: 'VPN', address: '10.1.2.3' },
  ] } : { room, players: [] });
  const view = show(`/screen/${room.id}`);
  await waitFor(() => assert.ok(view.getByLabelText('Party network')));
  assert.equal(view.container.querySelector('svg'), null);
  fireEvent.change(view.getByLabelText('Party network'), { target: { value: 'http://192.168.178.37:5173' } });
  await waitFor(() => assert.equal((view.getByRole('link', { name: 'Players / Игроки' }) as HTMLAnchorElement).href, 'http://192.168.178.37:5173/play/H8VXT'));
  assert.equal(view.container.querySelectorAll('svg').length, 1);
});

test('Player code route loads name and language join form', async () => {
  globalThis.fetch = async url => {
    assert.equal(String(url), '/api/rooms/code/H8VXT');
    return Response.json(room);
  };
  const view = show('/play/H8VXT');
  await waitFor(() => assert.ok(view.getByLabelText('Name')));
  assert.ok(view.getByLabelText('Language'));
  assert.ok(view.getByRole('button', { name: 'Join' }));
});
