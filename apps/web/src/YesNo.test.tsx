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

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });

test('Player mixed Single Choice and Yes / No flow resets selection, submits, restores and reveals', async () => {
  const live = Object.assign(new EventEmitter(), { connect() {}, disconnect() {} });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  const room = { id: 'room', code: 'ABCDE', quizTitle: 'Mixed', state: 'ANSWERING', closedAt: null };
  const timer = { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false };
  let game: any = { state: 'ANSWERING', questionId: 'single', text: 'Pick a fruit', options: [{ id: 'apple', text: 'Apple' }, { id: 'pear', text: 'Pear' }], submission: { submitted: true, optionId: 'apple' }, timer };
  const posts: any[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/answers')) {
      const body = JSON.parse(String(init?.body)); posts.push(body);
      game = { ...game, submission: { submitted: true, optionId: body.optionId } }; return Response.json(game.submission);
    }
    return Response.json({ room: { ...room, state: game.state }, active: true, player: { id: 'player', name: 'Alice', language: 'en' }, game });
  };
  const show = () => render(createElement(MemoryRouter, { initialEntries: ['/play/ABCDE'] }, createElement(App)));
  const view = show();
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  game = { state: 'ANSWERING', questionId: 'yesno', text: 'Is it true?', options: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }], submission: { submitted: false }, timer };
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' } }); });
  await act(async () => { live.emit('lobby:state', { room }); });
  await waitFor(() => assert.ok(view.getByText('Is it true?')));
  assert.equal(view.getAllByRole('radio').length, 2);
  assert.ok(view.getAllByRole('radio').every(r => !(r as HTMLInputElement).checked));
  fireEvent.click(view.getByLabelText('No')); fireEvent.click(view.getByLabelText('Yes'));
  assert.equal((view.getByLabelText('No') as HTMLInputElement).checked, false);
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  assert.deepEqual(posts, [{ token: 'secret', questionId: 'yesno', optionId: 'yes' }]);
  view.unmount();
  const reloaded = show();
  await waitFor(() => assert.ok(reloaded.getByText('Answer submitted')));
  assert.equal((reloaded.getByLabelText('Yes') as HTMLInputElement).checked, true);
  assert.equal((reloaded.getByLabelText('No') as HTMLInputElement).disabled, true);
  game = { ...game, state: 'ANSWER_REVEAL', correctOptionId: 'yes', result: { outcome: 'correct', points: 4 } };
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWER_REVEAL' } }); });
  await waitFor(() => assert.ok(reloaded.getByText('Correct! +4')));
  assert.ok(reloaded.getByText('Correct answer: Yes'));
});
