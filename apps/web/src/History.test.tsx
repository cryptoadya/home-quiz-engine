import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

void dom;
afterEach(cleanup);
function show(path = '/admin/history') {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
}

test('Admin links to clear history empty state with Test Game exclusion', async () => {
  const calls: string[] = [];
  globalThis.fetch = async input => { calls.push(String(input)); return Response.json([]); };
  const view = show('/admin');
  fireEvent.click(view.getByText('Import & history'));
  fireEvent.click(view.getByRole('link', { name: 'History' }));
  await waitFor(() => assert.ok(view.getByText(/No completed real games yet/)));
  assert.ok(view.getByText(/Test Games are excluded/));
  assert.ok(calls.includes('/api/history'));
  assert.equal(view.queryByRole('table'), null);
});

test('history renders frozen title/date/identity and final scores in server order, with escaped names', async () => {
  globalThis.fetch = async () => Response.json([
    { sessionId: 'game-new', completedAt: '2026-09-28T12:00:00.000Z', quizId: 'deleted-quiz', quizTitle: 'Original party',
      players: [{ playerId: 'a', displayName: '<script>Alice</script>', totalPoints: 5 }, { playerId: 'b', displayName: 'Bob', totalPoints: 0 }] },
    { sessionId: 'game-old', completedAt: '2026-09-27T12:00:00.000Z', quizId: 'old-quiz', quizTitle: 'Earlier party', players: [] },
  ]);
  const view = show();
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Original party' })));
  assert.deepEqual(view.getAllByRole('heading', { level: 2 }).map(node => node.textContent), ['Original party', 'Earlier party']);
  assert.ok(view.getByText(/deleted-quiz/));
  assert.equal(view.container.querySelector('time')?.getAttribute('datetime'), '2026-09-28T12:00:00.000Z');
  assert.deepEqual(view.getAllByRole('table')[0].textContent, 'Final player scoresPlayerPoints<script>Alice</script>5Bob0');
  assert.equal(view.container.querySelector('script'), null);
  assert.equal(view.queryByRole('link', { name: 'Original party' }), null);
});

test('history reports load failure without a misleading empty state', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 500 });
  const view = show();
  await waitFor(() => assert.equal(view.getByRole('alert').textContent, 'Unable to load history.'));
  assert.equal(view.queryByText(/No completed real games yet/), null);
});
