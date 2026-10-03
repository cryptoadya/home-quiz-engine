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

for (const themeId of ['default', 'halloween']) test(`editor renders one header/settings block with long question content (${themeId})`, async () => {
  const round = { id: 'round', quizId: quiz.id, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  const question = { id: 'question', roundId: round.id, type: 'single_choice', textRu: 'Длинный вопрос '.repeat(50), textEn: 'Long question '.repeat(50), points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 };
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([round]);
    if (path.endsWith('/questions')) return Response.json([question]);
    if (path.endsWith('/options') || path.endsWith('/media')) return Response.json([]);
    return Response.json({ ...quiz, themeId });
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByLabelText('Question text EN')));
  // DOM cardinality is independent of viewport size and full-page capture stitching.
  assert.equal(view.getAllByRole('heading', { name: 'Edit quiz' }).length, 1);
  for (const label of ['Title', 'Theme', 'Default answer time (seconds)', 'Shuffle answers']) {
    assert.equal(view.getAllByLabelText(label, { exact: true }).length, 1);
  }
  assert.equal(view.container.querySelectorAll('main.editor').length, 1);
});

test('Admin lists drafts, creates one, and confirms deletion', async () => {
  let confirmed = false;
  const calls: string[] = [];
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    calls.push(`${init?.method || 'GET'} ${path}`);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'QUIZ_NO_ROUNDS', message: 'Quiz has no rounds' }] });
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
  fireEvent.click(view.getByRole('button', { name: /Quiz list/ }));
  await waitFor(() => assert.ok(view.getByText('More')));
  fireEvent.click(view.getByText('More'));
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

test('Admin duplicates a quiz through one API call and lists the returned copy', async () => {
  const calls: string[] = [];
  const copy = { ...quiz, id: 'quiz-2', title: 'New Quiz (Copy)' };
  let fail = true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    calls.push(`${init?.method || 'GET'} ${path}`);
    if (path === '/api/quizzes') return Response.json([quiz]);
    if (path === '/api/quizzes/quiz-1/duplicate') return fail
      ? Response.json({ error: 'Copy unavailable.' }, { status: 500 })
      : Response.json(copy, { status: 201 });
    return Response.json({ error: 'Unexpected request.' }, { status: 404 });
  };
  const view = show('/admin');
  await waitFor(() => assert.ok(view.getByText('More')));
  fireEvent.click(view.getByText('More'));
  fireEvent.click(view.getByRole('button', { name: 'Duplicate New Quiz' }));
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Copy unavailable.')));
  assert.equal(view.queryByRole('link', { name: 'New Quiz (Copy)' }), null);
  fail = false;
  fireEvent.click(view.getByRole('button', { name: 'Duplicate New Quiz' }));
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'New Quiz (Copy)' })));
  assert.equal(view.queryByRole('alert'), null);
  assert.deepEqual(calls.filter((call) => call.includes('/duplicate')), [
    'POST /api/quizzes/quiz-1/duplicate', 'POST /api/quizzes/quiz-1/duplicate',
  ]);
});

test('editor autosaves basic settings and keeps a failed save visible', async () => {
  const updates: unknown[] = [];
  let fail = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/media')) return Response.json([]);
    if (String(input).endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'QUIZ_NO_ROUNDS', message: 'Quiz has no rounds' }] });
    if (String(input).endsWith('/rounds')) return Response.json([]);
    if (init?.method === 'PUT') {
      updates.push(JSON.parse(String(init.body)));
      return fail ? Response.json({ error: 'Save unavailable.' }, { status: 500 }) : Response.json({ ...quiz, themeId: 'halloween' });
    }
    return Response.json({ ...quiz, themeId: 'halloween' });
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByDisplayValue('New Quiz')));
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Party Quiz' } });
  fireEvent.change(view.getByLabelText('Theme'), { target: { value: 'default' } });
  fireEvent.change(view.getByLabelText('Default answer time (seconds)'), { target: { value: '45' } });
  fireEvent.click(view.getByLabelText('Shuffle answers'));
  assert.equal(view.getAllByRole('status')[0].textContent, 'Saving…');
  await waitFor(() => assert.equal(view.getAllByRole('status')[0].textContent, 'Saved'), { timeout: 2000 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    title: 'Party Quiz', themeId: 'default', defaultAnswerTimeSeconds: 45, shuffleAnswers: true,
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
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'ROUND_NO_QUESTIONS', message: 'Round has no questions', roundId: 'r1' }] });
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
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Rounds & questions' })));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'First / Первый' })));
  fireEvent.click(view.getByRole('button', { name: 'Add round' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'New Round / Новый раунд' })));
  fireEvent.change(view.getByLabelText('Round title RU'), { target: { value: 'Финал' } });
  fireEvent.change(view.getByLabelText('Round title EN'), { target: { value: 'Final' } });
  fireEvent.click(view.getByLabelText('Show leaderboard after this round'));
  assert.equal(view.getByText('Saving…', { selector: '.round-status' }).textContent, 'Saving…');
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
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'ROUND_NO_QUESTIONS', message: 'Round has no questions', roundId: 'r1' }] });
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

test('editor shows readiness, problems, and selects the affected round', async () => {
  const rounds = [
    { id: 'r1', quizId: quiz.id, titleRu: 'Первый', titleEn: 'First', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 },
    { id: 'r2', quizId: quiz.id, titleRu: 'Второй', titleEn: 'Second', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 1 },
  ];
  let validation = { ready: false, problems: [{ code: 'ROUND_NO_QUESTIONS', message: 'Round “Second” has no questions', roundId: 'r2' }] };
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json(validation);
    if (path.endsWith('/rounds')) return Response.json(rounds);
    if (path.endsWith('/questions')) return Response.json([]);
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByText('Problems to fix · 1')));
  fireEvent.click(view.getByText('Show problems'));
  assert.ok(view.getByText('Round “Second” has no questions'));
  fireEvent.click(view.getByRole('button', { name: 'Round “Second” has no questions' }));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Second / Второй' }).className.includes('selected-round')));
  validation = { ready: true, problems: [] };
  // A successful persisted quiz edit refreshes the server's authoritative result.
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json(validation);
    if (path.endsWith('/rounds')) return Response.json(rounds);
    if (path.endsWith('/questions')) return Response.json([]);
    if (init?.method === 'PUT') return Response.json(quiz);
    return Response.json(quiz);
  };
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Party Quiz' } });
  await waitFor(() => assert.ok(view.getByText('Ready to play')), { timeout: 2000 });
});

test('ready Admin opens Host, reload recovers the room, and confirmed close updates it', async () => {
  const room = { id: 'room-1', quizId: quiz.id, quizTitle: quiz.title, code: 'ABCDE', state: 'LOBBY', createdAt: quiz.createdAt, closedAt: null as string | null };
  let confirmed = false;
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready: true, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([]);
    if (path === `/api/quizzes/${quiz.id}/rooms` && init?.method === 'POST') return Response.json(room, { status: 201 });
    if (path === '/api/rooms/room-1/close' && init?.method === 'POST') { room.closedAt = quiz.createdAt; return Response.json(room); }
    if (path === '/api/rooms/code/ABCDE') return Response.json(room);
    if (path === '/api/rooms/room-1/game/host') return Response.json({ room, players: [] });
    if (path === `/api/quizzes/${quiz.id}`) return Response.json(quiz);
    throw new Error(`Unexpected request: ${path}`);
  };
  let view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Open lobby' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByRole('button', { name: 'Open lobby' }));
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Host' })));
  await waitFor(() => assert.ok(view.getByText('ABCDE')));
  assert.equal(view.queryByRole('region', { name: 'Device setup / Подключение устройств' }), null);
  assert.ok(view.getByText('New Quiz'));
  view.unmount();
  view = show('/host/room-1');
  await waitFor(() => assert.ok(view.getByText('ABCDE')));
  fireEvent.click(view.getByRole('button', { name: 'Close room' }));
  assert.equal(room.closedAt, null);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Close room' }));
  await waitFor(() => assert.ok(view.getByText('Room closed')));
  assert.equal(view.queryByRole('button', { name: 'Close room' }), null);
});

test('draft cannot launch and server launch rejection remains visible', async () => {
  let ready = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([]);
    if (path.endsWith('/rooms') && init?.method === 'POST') return Response.json({ error: 'Quiz is not ready.', validation: { ready: false, problems: [] } }, { status: 409 });
    return Response.json(quiz);
  };
  let view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Open lobby' })));
  assert.equal((view.getByRole('button', { name: 'Open lobby' }) as HTMLButtonElement).disabled, true);
  view.unmount();
  ready = true;
  view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Open lobby' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByRole('button', { name: 'Open lobby' }));
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Quiz is not ready.')));
  assert.ok(view.getByRole('heading', { name: 'Edit quiz' }));
});

test('Admin starts a labeled Test Game lobby for the current quiz and shows launch errors', async () => {
  let ready = false, fail = true;
  const calls: string[] = [];
  const room = { id: 'test-room', code: 'ABCDE', quizTitle: quiz.title, state: 'LOBBY', closedAt: null, isTest: true };
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) return Response.json([]);
    if (path.endsWith('/validation')) return Response.json({ ready, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([]);
    if (path.endsWith('/test-games') && init?.method === 'POST') {
      calls.push(path);
      return fail ? Response.json({ error: 'Quiz is not ready.' }, { status: 409 }) : Response.json(room, { status: 201 });
    }
    if (path === '/api/rooms/code/ABCDE') return Response.json(room);
    if (path.endsWith('/game/host')) return Response.json({ room, players: [] });
    return Response.json(quiz);
  };
  let view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByText('Rehearse & export')));
  assert.equal(view.getByRole('button', { name: 'Rehearse with devices', hidden: true }).closest('details')?.open, false);
  fireEvent.click(view.getByText('Rehearse & export'));
  assert.equal((view.getByRole('button', { name: 'Rehearse with devices' }) as HTMLButtonElement).disabled, true);
  view.unmount(); ready = true;
  view = show('/admin/quizzes/quiz-1');
  await waitFor(() => assert.ok(view.getByText('Rehearse & export')));
  fireEvent.click(view.getByText('Rehearse & export'));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Rehearse with devices' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByRole('button', { name: 'Rehearse with devices' }));
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Quiz is not ready.')));
  fail = false;
  fireEvent.click(view.getByRole('button', { name: 'Rehearse with devices' }));
  await waitFor(() => assert.ok(view.getByText('Тестовая игра / Test Game')));
  assert.ok(view.getByText('ABCDE'));
  assert.deepEqual(calls, ['/api/quizzes/quiz-1/test-games', '/api/quizzes/quiz-1/test-games']);
});

test('Admin imports ZIP with success/edit link and unavailable-theme warning; failed import can be retried', async () => {
  const copy = { ...quiz, id: 'imported-quiz', themeId: 'missing-theme' };
  let fail = true;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/quizzes/import') {
      calls.push(init!);
      return fail ? Response.json({ error: 'Missing media.' }, { status: 400 }) : Response.json(copy, { status: 201 });
    }
    return Response.json([]);
  };
  const view = show('/admin');
  fireEvent.click(view.getByText('Import & history'));
  assert.ok(view.getByRole('button', { name: 'Import Quiz' }));
  const input = view.getByLabelText('Quiz ZIP');
  fireEvent.change(input, { target: { files: [new File(['zip'], 'quiz.zip', { type: 'application/zip' })] } });
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Missing media/));
  assert.equal(view.queryByRole('link', { name: 'Open imported quiz' }), null);
  fail = false;
  fireEvent.change(input, { target: { files: [new File(['zip'], 'quiz.zip', { type: 'application/zip' })] } });
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'Open imported quiz' })));
  assert.equal(view.getByRole('link', { name: 'Open imported quiz' }).getAttribute('href'), '/admin/quizzes/imported-quiz');
  assert.match(view.getByRole('status').textContent!, /editable Draft/);
  assert.match(view.getByRole('alert').textContent!, /Using Default.*choose a theme in Edit/);
  assert.equal(calls.length, 2); assert.equal(calls[1].method, 'POST'); assert.ok(calls[1].body instanceof FormData);
});

test('Admin export downloads ZIP and reports errors and success without gameplay calls', async () => {
  let fail = true;
  const calls: string[] = [];
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  let downloaded = false, revoked = false;
  URL.createObjectURL = () => 'blob:quiz-archive'; URL.revokeObjectURL = () => { revoked = true; };
  dom.window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download === 'quiz.zip'; };
  try {
    globalThis.fetch = async input => {
      const path = String(input);
    if (path.endsWith('/media')) return Response.json([]); calls.push(path);
      if (path.endsWith('/export')) return fail ? Response.json({ error: 'Missing source media.' }, { status: 400 }) : new Response('zip', { headers: { 'Content-Type': 'application/zip' } });
      return Response.json([quiz]);
    };
    const view = show('/admin');
    await waitFor(() => assert.ok(view.getByText('More')));
  fireEvent.click(view.getByText('More'));
    fireEvent.click(view.getByRole('button', { name: 'Export New Quiz' }));
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Missing source media/));
    fail = false; fireEvent.click(view.getByRole('button', { name: 'Export New Quiz' }));
    await waitFor(() => assert.match(view.getByRole('status').textContent!, /ZIP downloaded/));
    assert.ok(downloaded && revoked); assert.equal(view.queryByRole('alert'), null);
    assert.ok(calls.every(path => path === '/api/quizzes' || path === '/api/quizzes/quiz-1/export'));
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; dom.window.HTMLAnchorElement.prototype.click = originalClick; }
});
