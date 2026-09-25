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
    if (path.endsWith('/rounds')) return Response.json([]);
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
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/rounds')) return Response.json([]);
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
  assert.equal(view.getAllByRole('status')[0].textContent, 'Saving...');
  await waitFor(() => assert.equal(view.getAllByRole('status')[0].textContent, 'Saved'), { timeout: 2000 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    title: 'Party Quiz', themeId: 'halloween', defaultAnswerTimeSeconds: 45, shuffleAnswers: true,
  });

  fail = true;
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Another Quiz' } });
  await waitFor(() => assert.equal(view.getAllByRole('status')[0].textContent, 'Save failed'), { timeout: 2000 });
  assert.ok(view.getByRole('alert').textContent?.includes('Save unavailable.'));
});

test('editor loads, adds, edits, reorders, and confirms round deletion', async () => {
  const rounds = [
    { id: 'r1', quizId: quiz.id, titleRu: 'Первый', titleEn: 'First', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0, createdAt: quiz.createdAt, updatedAt: quiz.updatedAt },
    { id: 'r2', quizId: quiz.id, titleRu: 'Второй', titleEn: 'Second', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 1, createdAt: quiz.createdAt, updatedAt: quiz.updatedAt },
  ];
  let confirmed = false;
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === `/api/quizzes/${quiz.id}`) return Response.json(quiz);
    if (path.endsWith('/rounds')) {
      if (init?.method === 'POST') {
        const round = { ...rounds[0], id: 'r3', titleRu: 'Новый раунд', titleEn: 'New Round', position: rounds.length };
        rounds.push(round);
        return Response.json(round, { status: 201 });
      }
      return Response.json(rounds);
    }
    if (path.endsWith('/order')) {
      const ids = JSON.parse(String(init?.body)).ids as string[];
      rounds.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      rounds.forEach((round, position) => { round.position = position; });
      return Response.json(rounds);
    }
    const id = path.split('/').pop();
    const index = rounds.findIndex((round) => round.id === id);
    if (init?.method === 'DELETE') {
      rounds.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (init?.method === 'PUT') {
      Object.assign(rounds[index], JSON.parse(String(init.body)));
      return Response.json(rounds[index]);
    }
    return Response.json({ error: 'Missing' }, { status: 404 });
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Rounds' })));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'First / Первый' })));
  fireEvent.click(view.getByRole('button', { name: 'Add round' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'New Round / Новый раунд' })));
  fireEvent.change(view.getByLabelText('Round title RU'), { target: { value: 'Финал' } });
  fireEvent.change(view.getByLabelText('Round title EN'), { target: { value: 'Final' } });
  fireEvent.click(view.getByLabelText('Show leaderboard after this round'));
  assert.equal(view.getByText('Saving...', { selector: '.round-status' }).textContent, 'Saving...');
  await waitFor(() => assert.equal(view.getByText('Saved', { selector: '.round-status' }).textContent, 'Saved'), { timeout: 2000 });
  assert.equal(rounds[2].titleEn, 'Final');
  assert.equal(rounds[2].showLeaderboardAfter, true);
  fireEvent.click(view.getByRole('button', { name: 'Move Final up' }));
  await waitFor(() => assert.deepEqual(rounds.map((round) => round.id), ['r1', 'r3', 'r2']));
  fireEvent.click(view.getByRole('button', { name: 'Delete round' }));
  assert.equal(rounds.length, 3);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Delete round' }));
  await waitFor(() => assert.equal(rounds.length, 2));
  assert.equal(view.queryByRole('button', { name: /Final/ }), null);
});

test('round editor waits for both description languages and shows failed autosave', async () => {
  const round = { id: 'r1', quizId: quiz.id, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0, createdAt: quiz.createdAt, updatedAt: quiz.updatedAt };
  const updates: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/rounds')) return Response.json([round]);
    if (path.endsWith('/questions')) return Response.json([]);
    if (path.endsWith('/r1') && init?.method === 'PUT') {
      updates.push(JSON.parse(String(init.body)));
      return Response.json({ error: 'Round save unavailable.' }, { status: 500 });
    }
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByLabelText('Round description RU')));
  fireEvent.change(view.getByLabelText('Round description RU'), { target: { value: 'Описание' } });
  assert.equal(view.getByText('Complete both languages to save').textContent, 'Complete both languages to save');
  assert.equal(updates.length, 0);
  fireEvent.change(view.getByLabelText('Round description EN'), { target: { value: 'Description' } });
  await waitFor(() => assert.equal(view.getByText('Save failed', { selector: '.round-status' }).textContent, 'Save failed'), { timeout: 2000 });
  assert.equal(updates.length, 1);
  assert.ok(view.getByRole('alert').textContent?.includes('Round save unavailable.'));
});
