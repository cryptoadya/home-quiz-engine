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

const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', themeId: 'default', state: 'LOBBY', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }

for (const path of ['/host/room', '/screen/room', '/play/ABCDE']) {
  for (const themeId of ['default', 'halloween', 'missing-theme', '', undefined, null]) {
    test(`${path} uses Default for theme ${String(themeId)} on reload and realtime recovery`, async () => {
      const live = Object.assign(new EventEmitter(), { disconnect() {}, connect() {} });
      mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
      const themedRoom = { ...room, themeId };
      if (path.startsWith('/play')) dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
      globalThis.fetch = async () => Response.json(path.startsWith('/play')
        ? { room: themedRoom, player, active: true } : { room: themedRoom, players: [player] });
      const view = show(path);
      await waitFor(() => assert.ok(view.getByText('Party')));
      const main = view.getByRole('main');
      assert.equal(main.dataset.theme, 'default');
      assert.equal(main.style.getPropertyValue('--theme-text'), '#1c2430');
      await act(async () => { live.emit('lobby:state', { room: { ...themedRoom, state: 'ROUND_INTRO' }, players: [player] }); });
      assert.equal(main.dataset.theme, 'default');
      assert.equal(main.style.getPropertyValue('--theme-background'), '#f5f7fa');
      assert.ok(view.getByText('Party'));
    });
  }
}

test('Admin preserves an unavailable selection through edits and allows selecting Default', async () => {
  const quiz = { id: 'quiz', title: 'Party', themeId: 'missing-theme', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
  const updates: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (String(input).endsWith('/rounds')) return Response.json([]);
    if (init?.method === 'PUT') { updates.push(JSON.parse(String(init.body))); return Response.json(quiz); }
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz');
  await waitFor(() => assert.ok(view.getByDisplayValue('Party')));
  assert.equal(view.getByRole('main').dataset.theme, 'default');
  assert.equal((view.getByLabelText('Theme') as HTMLSelectElement).value, 'missing-theme');
  assert.match(view.getByText(/Theme unavailable/).textContent!, /Default/);
  assert.equal(view.queryByRole('option', { name: 'Halloween' }), null);
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Edited' } });
  await waitFor(() => assert.equal(updates.length, 1));
  assert.equal(updates[0].themeId, 'missing-theme');
  fireEvent.change(view.getByLabelText('Theme'), { target: { value: 'default' } });
  await waitFor(() => assert.equal(updates.length, 2));
  assert.equal(updates[1].themeId, 'default');
  assert.equal(view.queryByText(/Theme unavailable/), null);
});
