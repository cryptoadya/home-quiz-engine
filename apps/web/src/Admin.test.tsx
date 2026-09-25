import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

const quiz = {
  id: 'quiz-1', title: 'New Quiz', themeId: 'default',
  defaultAnswerTimeSeconds: 30, shuffleAnswers: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function show(path: string) {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
}

afterEach(() => { cleanup(); });

test('Admin lists drafts, creates one, and confirms deletion', async () => {
  let confirmed = false;
  const calls: string[] = [];
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method || 'GET'} ${path}`);
    if (init?.method === 'POST') return Response.json(quiz, { status: 201 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(path === '/api/quizzes' ? [quiz] : quiz);
  };

  const view = show('/admin');
  await waitFor(() => assert.ok(view.getByText('New Quiz')));
  assert.ok(view.getByText(/Modified/));
  fireEvent.click(view.getByRole('link', { name: 'New Quiz' }));
  await waitFor(() => assert.ok(view.getByDisplayValue('New Quiz')));
  fireEvent.click(view.getByRole('link', { name: /Quiz list/ }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Delete New Quiz' })));
  fireEvent.click(view.getByRole('button', { name: 'Delete New Quiz' }));
  assert.equal(calls.filter((call) => call.startsWith('DELETE')).length, 0);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Delete New Quiz' }));
  await waitFor(() => assert.ok(view.getByText(/No quizzes yet/)));
  assert.equal(calls.filter((call) => call.startsWith('DELETE')).length, 1);

  fireEvent.click(view.getByRole('button', { name: 'Create quiz' }));
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Edit quiz' })));
  await waitFor(() => assert.ok(view.getByDisplayValue('New Quiz')));
  assert.ok(calls.includes('POST /api/quizzes'));
});

test('editor autosaves basic settings and keeps a failed save visible', async () => {
  const updates: unknown[] = [];
  let fail = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') {
      updates.push(JSON.parse(String(init.body)));
      return fail ? Response.json({ error: 'Save unavailable.' }, { status: 500 }) : Response.json(quiz);
    }
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByDisplayValue('New Quiz')));
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Party Quiz' } });
  fireEvent.change(view.getByLabelText('Theme'), { target: { value: 'halloween' } });
  fireEvent.change(view.getByLabelText('Default answer time (seconds)'), { target: { value: '45' } });
  fireEvent.click(view.getByLabelText('Shuffle answers'));
  assert.equal(view.getByRole('status').textContent, 'Saving...');
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'Saved'), { timeout: 2000 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    title: 'Party Quiz', themeId: 'halloween', defaultAnswerTimeSeconds: 45, shuffleAnswers: true,
  });

  fail = true;
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Another Quiz' } });
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'Save failed'), { timeout: 2000 });
  assert.ok(view.getByRole('alert').textContent?.includes('Save unavailable.'));
});
