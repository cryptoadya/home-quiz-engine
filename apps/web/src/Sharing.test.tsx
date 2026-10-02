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

const room = { id: 'current-uuid', code: 'ABCDE', shareKey: 'current-marker', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.reconfigure({ url: 'http://localhost' }); });
function Location() { return createElement('output', { 'aria-label': 'Current route' }, useLocation().pathname); }
function show(path: string) {
  mock.method(lobbyTransport, 'connect', () => Object.assign(new EventEmitter(), { connect() {}, disconnect() {} }) as unknown as Socket);
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App), createElement(Location)));
}

test('localhost setup uses the single LAN candidate, preserves frontend port and copies Host link', async () => {
  dom.reconfigure({ url: 'http://localhost:5180' });
  globalThis.fetch = async url => Response.json(String(url) === '/api/network' ? { addresses: [{ name: 'Wi-Fi', address: '192.168.1.50' }] } : { room, players: [] });
  const clipboard = { writeText: async (_text: string) => {} };
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard });
  const copy = mock.method(clipboard, 'writeText');
  const view = show('/host/current-uuid');
  await waitFor(() => assert.equal(view.container.querySelectorAll('.device-setup svg').length, 3));
  const host = view.getByRole('link', { name: 'Open Host' }) as HTMLAnchorElement;
  assert.equal(host.href, 'http://192.168.1.50:5180/host?code=ABCDE&session=current-marker');
  assert.equal((view.getByRole('link', { name: 'Open Screen' }) as HTMLAnchorElement).href, 'http://192.168.1.50:5180/screen?code=ABCDE&session=current-marker');
  const players = view.getByRole('link', { name: 'Players / Игроки' }) as HTMLAnchorElement;
  assert.equal(players.href, 'http://192.168.1.50:5180/play/ABCDE');
  assert.equal(players.querySelectorAll('svg').length, 1);
  fireEvent.click(view.getByRole('button', { name: 'Copy Host link' }));
  await waitFor(() => assert.ok(view.getByText('Copied')));
  assert.equal(copy.mock.calls[0].arguments[0], host.href);
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
  fireEvent.click(view.getByRole('button', { name: 'Copy Screen link' }));
  await waitFor(() => assert.ok(view.getByText(/Select the link/)));
  assert.equal(document.activeElement, view.getByLabelText('Screen link'));
});

test('multiple LAN candidates require a choice; manual loopback fallback is rejected', async () => {
  dom.reconfigure({ url: 'http://localhost:5173' });
  globalThis.fetch = async url => Response.json(String(url) === '/api/network' ? { addresses: [{ name: 'Wi-Fi', address: '192.168.1.50' }, { name: 'VPN', address: '10.1.2.3' }] } : { room, players: [] });
  const view = show('/host/current-uuid');
  await waitFor(() => assert.ok(view.getByLabelText('Party network')));
  assert.equal(view.container.querySelector('.device-setup svg'), null);
  fireEvent.change(view.getByLabelText('Network address'), { target: { value: '127.0.0.1' } });
  fireEvent.click(view.getByRole('button', { name: 'Use address' }));
  assert.equal(view.container.querySelector('.device-setup svg'), null);
  fireEvent.change(view.getByLabelText('Party network'), { target: { value: '192.168.1.50' } });
  await waitFor(() => assert.equal(view.container.querySelectorAll('.device-setup svg').length, 3));
});

test('manual network fallback works when discovery fails and keeps the frontend port', async () => {
  dom.reconfigure({ url: 'http://localhost:5181' });
  globalThis.fetch = async url => String(url) === '/api/network'
    ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ room, players: [] });
  const view = show('/host/current-uuid');
  await waitFor(() => assert.ok(view.getByText(/Choose this Mac’s address/)));
  fireEvent.change(view.getByLabelText('Network address'), { target: { value: '192.168.1.60' } });
  fireEvent.click(view.getByRole('button', { name: 'Use address' }));
  await waitFor(() => assert.equal((view.getByRole('link', { name: 'Open Host' }) as HTMLAnchorElement).origin, 'http://192.168.1.60:5181'));
  assert.equal(view.queryByRole('alert'), null);
});

for (const destination of ['host', 'screen']) {
  test(`${destination} convenience route binds to UUID; plain code entry works`, async () => {
    globalThis.fetch = async url => Response.json(String(url).startsWith('/api/rooms/code/') ? room : { room, players: [] });
    let view = show(`/${destination}?code=abcde&session=current-marker`);
    await waitFor(() => assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/current-uuid`));
    view.unmount();
    view = show(`/${destination}`);
    fireEvent.change(view.getByLabelText('Room code'), { target: { value: 'abcde' } });
    fireEvent.click(view.getByRole('button', { name: 'Open room' }));
    await waitFor(() => assert.equal(view.getByLabelText('Current route').textContent, `/${destination}/current-uuid`));
  });
  test(`${destination} rejects an old shared link after code reuse and missing or closed codes`, async () => {
    globalThis.fetch = async () => Response.json({ ...room, id: 'replacement', shareKey: 'replacement-marker' });
    let view = show(`/${destination}?code=ABCDE&session=current-marker`);
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, /another room|expired/i));
    assert.equal(view.getByLabelText('Current route').textContent, `/${destination}`);
    view.unmount();
    globalThis.fetch = async () => Response.json({ error: 'Active room not found.' }, { status: 404 });
    view = show(`/${destination}?code=ABCDE`);
    await waitFor(() => assert.ok(view.getByRole('alert')));
    view.unmount();
    globalThis.fetch = async () => Response.json({ ...room, closedAt: 'now' });
    view = show(`/${destination}?code=ABCDE`);
    await waitFor(() => assert.ok(view.getByRole('alert')));
  });
}
