import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QuizEditor } from './Admin';

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function editor(matching = false, secondRound = false) {
  const quiz = { id: 'q', title: 'Quiz', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
  const round = { id: 'r', quizId: 'q', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  const question = { id: 'a', roundId: 'r', type: matching ? 'matching' : 'single_choice', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 };
  const option = { id: 'o', questionId: 'a', textRu: '', textEn: '', isCorrect: false, position: 0 };
  const pair = { id: 'p', questionId: 'a', left: { kind: 'text', textRu: '', textEn: '' }, right: { kind: 'text', textRu: '', textEn: '' }, position: 0 };
  const writes: { path: string; body: Record<string, unknown>; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const actions: string[] = [];
  let validations = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') {
      const reply = deferred<Response>();
      writes.push({ path, body: init.body ? JSON.parse(String(init.body)) : {}, reply });
      return reply.promise;
    }
    if (path.endsWith('/export') || init?.method === 'POST') {
      actions.push(path);
      return path.endsWith('/export') ? new Response('zip') : Response.json({ id: 'room' });
    }
    if (path.endsWith('/validation')) { validations++; return Response.json({ ready: true, problems: [] }); }
    if (path.endsWith('/rounds')) return Response.json(secondRound ? [round, { ...round, id: 'r2', titleRu: 'Второй', titleEn: 'Second', position: 1 }] : [round]);
    if (path.endsWith('/questions')) return Response.json([question]);
    if (path.endsWith('/options')) return Response.json([option]);
    if (path.endsWith('/pairs')) return Response.json([pair]);
    if (path.endsWith('/media')) return Response.json([]);
    return Response.json(quiz);
  };
  URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  const view = render(createElement(MemoryRouter, { initialEntries: ['/admin/quizzes/q'] }, createElement(Routes, null,
    createElement(Route, { path: '/admin/quizzes/:quizId', element: createElement(QuizEditor) }),
    createElement(Route, { path: '/host/:roomId', element: createElement('p', null, 'Lobby opened') }))));
  await waitFor(() => assert.ok(view.getByLabelText(matching ? 'Pair 1 left EN' : 'Option 1 EN')));
  const edit = (label: string, value: string) => fireEvent.change(view.getByLabelText(label, { exact: true }), { target: { value } });
  const reply = async (index: number, ok = true) => {
    await waitFor(() => assert.ok(writes[index]), { timeout: 2000 });
    await act(async () => { writes[index].reply.resolve(Response.json(ok ? {} : { error: 'Offline' }, { status: ok ? 200 : 500 })); });
  };
  return { view, writes, actions, edit, reply, validations: () => validations };
}

for (const matching of [false, true]) test(`failed first PUT retains later ${matching ? 'pair' : 'option'} edits and retry saves both`, async () => {
  const e = await editor(matching);
  const initialValidation = e.validations();
  e.edit('Question text EN', 'Question draft');
  e.edit(matching ? 'Pair 1 left EN' : 'Option 1 EN', 'Answer draft');
  await e.reply(0, false);
  assert.equal(e.writes.length, 1);
  assert.equal(e.validations(), initialValidation);
  assert.equal(e.view.container.querySelector('.question-status')?.textContent, 'Save failed');
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(1);
  assert.equal(e.writes[1].body.textEn, 'Question draft');
  assert.equal(e.actions.length, 0);
  await e.reply(2);
  assert.ok(e.writes[2].path.includes(matching ? '/pairs/p' : '/options/o'));
  await waitFor(() => assert.equal(e.actions.length, 1));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

for (const label of ['Question text EN', 'Round title EN', 'Title']) test(`${label}: older in-flight completion retains the newest edit`, async () => {
  const e = await editor();
  e.edit(label, 'Older');
  await waitFor(() => assert.equal(e.writes.length, 1), { timeout: 2000 });
  e.edit(label, 'Newest');
  await e.reply(0);
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  await e.reply(1);
  assert.ok(Object.values(e.writes[1].body).includes('Newest'));
  await waitFor(() => assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved'));
});

test('successful settings save cannot conceal a failed child edit', async () => {
  const e = await editor();
  e.edit('Question text EN', 'Retained');
  await e.reply(0, false);
  e.edit('Title', 'New title');
  await e.reply(1);
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  assert.equal(e.view.container.querySelector('.question-status')?.textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(2);
  assert.equal(e.writes[2].body.textEn, 'Retained');
  await waitFor(() => assert.equal(e.actions.length, 1));
});

for (const action of ['Export Quiz', 'Open lobby', 'Start Test Game']) {
  test(`${action} flushes and waits for settings, rounds and questions`, async () => {
    const e = await editor();
    e.edit('Title', 'Saved quiz'); e.edit('Round title EN', 'Saved round'); e.edit('Question text EN', 'Saved question');
    fireEvent.click(e.view.getByRole('button', { name: action }));
    for (let index = 0; index < 3; index++) { assert.equal(e.actions.length, 0); await e.reply(index); }
    await waitFor(() => assert.equal(e.actions.length, 1));
    assert.equal(e.actions[0], `/api/quizzes/q/${action === 'Export Quiz' ? 'export' : action === 'Open lobby' ? 'rooms' : 'test-games'}`);
  });
  test(`${action} aborts on failed child saves`, async () => {
    const e = await editor();
    e.edit('Question text EN', 'Unsaved');
    fireEvent.click(e.view.getByRole('button', { name: action }));
    await e.reply(0, false);
    assert.equal(e.actions.length, 0);
    assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
    assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Offline')));
  });
}

test('Export joins an in-flight child save and aborts if that request fails', async () => {
  const e = await editor();
  e.edit('Question text EN', 'In flight');
  await waitFor(() => assert.equal(e.writes.length, 1), { timeout: 2000 });
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(0, false);
  assert.equal(e.writes.length, 1, 'A failed barrier must not silently retry');
  assert.equal(e.actions.length, 0);
});

test('failed round stays unsaved after a settings save and is retried by export', async () => {
  const e = await editor();
  e.edit('Round title EN', 'Retained round');
  await e.reply(0, false);
  e.edit('Title', 'Later settings');
  await e.reply(1);
  assert.equal(e.view.container.querySelector('.round-status')?.textContent, 'Save failed');
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(2);
  assert.equal(e.writes[2].body.titleEn, 'Retained round');
  await waitFor(() => assert.equal(e.actions.length, 1));
});

test('incomplete round blocks export until both languages are complete', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Описание');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await waitFor(() => assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Complete both languages'))));
  assert.equal(e.writes.length, 0); assert.equal(e.actions.length, 0);
  e.edit('Round description EN', 'Description');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(0);
  assert.equal(e.writes[0].body.descriptionRu, 'Описание');
  await waitFor(() => assert.equal(e.actions.length, 1));
});


test('Export waits for immediate correct-option persistence', async () => {
  const e = await editor();
  fireEvent.click(e.view.getByLabelText('Correct answer, option 1'));
  await waitFor(() => assert.equal(e.writes.length, 1));
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  assert.equal(e.actions.length, 0);
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  await act(async () => { e.writes[0].reply.resolve(Response.json([])); });
  await waitFor(() => assert.equal(e.actions.length, 1));
});


test('round selection retains a failed child and its visible draft until retry succeeds', async () => {
  const e = await editor(false, true);
  e.edit('Option 1 EN', 'Retained option');
  fireEvent.click(e.view.getByRole('button', { name: 'Second / Второй' }));
  await e.reply(0, false);
  assert.equal((e.view.getByLabelText('Option 1 EN') as HTMLInputElement).value, 'Retained option');
  assert.ok(e.view.getByRole('button', { name: 'Round / Раунд' }).className.includes('selected-round'));
  fireEvent.click(e.view.getByRole('button', { name: 'Second / Второй' }));
  await e.reply(1);
  assert.equal(e.writes[1].body.textEn, 'Retained option');
  await waitFor(() => assert.ok(e.view.getByRole('button', { name: 'Second / Второй' }).className.includes('selected-round')));
});

for (const label of ['Question text EN', 'Round title EN']) test(`${label}: an older failed request retains a newer edit for retry`, async () => {
  const e = await editor();
  e.edit(label, 'Older');
  await waitFor(() => assert.equal(e.writes.length, 1), { timeout: 2000 });
  e.edit(label, 'Latest draft');
  await e.reply(0, false);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(1);
  assert.ok(Object.values(e.writes[1].body).includes('Latest draft'));
  await waitFor(() => assert.equal(e.actions.length, 1));
});
