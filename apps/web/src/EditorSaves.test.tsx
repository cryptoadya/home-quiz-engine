import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createElement, useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QuizEditor } from './Admin';
import { EditorSaves, useEditorSave, useSaveBarrier } from './EditorSaves';
import { Rounds } from './Rounds';
import { Questions, type Option, type Question } from './Questions';

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
test('round description editors cap both languages at 5000 characters', async () => {
  const e = await editor();
  assert.equal(e.view.getByLabelText('Round description RU').getAttribute('maxlength'), '5000');
  assert.equal(e.view.getByLabelText('Round description EN').getAttribute('maxlength'), '5000');
});
async function editor(matching = false, secondRound = false) {
  const quiz = { id: 'q', title: 'Quiz', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
  const round = { id: 'r', quizId: 'q', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  const question = { id: 'a', roundId: 'r', type: matching ? 'matching' : 'single_choice', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 };
  const option = { id: 'o', questionId: 'a', textRu: '', textEn: '', isCorrect: false, position: 0 };
  const pair = { id: 'p', questionId: 'a', left: { kind: 'text', textRu: '', textEn: '' }, right: { kind: 'text', textRu: '', textEn: '' }, position: 0 };
  const writes: { path: string; body: Record<string, unknown>; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const actions: string[] = [];
  const deletions: { path: string; reply: ReturnType<typeof deferred<Response>> }[] = [];
  window.confirm = () => true;
  const mediaMutations: { method: string; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const mediaItem = { id: 'm', name: 'picture.gif', kind: 'image', mimeType: 'image/gif', sizeBytes: 100 };
  let validations = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.includes('/media') && (init?.method === 'POST' || init?.method === 'DELETE')) {
      const reply = deferred<Response>();
      mediaMutations.push({ method: init.method, reply });
      return reply.promise;
    }
    if (init?.method === 'DELETE') {
      const reply = deferred<Response>();
      deletions.push({ path, reply });
      return reply.promise;
    }
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
    if (path.endsWith('/media')) return Response.json([mediaItem]);
    return Response.json(quiz);
  };
  URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  const view = render(createElement(MemoryRouter, { initialEntries: ['/admin/quizzes/q'] }, createElement(Routes, null,
    createElement(Route, { path: '/admin/quizzes/:quizId', element: createElement(QuizEditor) }),
    createElement(Route, { path: '/admin', element: createElement('p', null, 'Quiz list opened') }),
    createElement(Route, { path: '/host/:roomId', element: createElement('p', null, 'Lobby opened') }))));
  await waitFor(() => assert.ok(view.getByLabelText(matching ? 'Pair 1 left EN' : 'Option 1 EN')));
  fireEvent.click(view.getByText('Rehearse & export'));
  const edit = (label: string, value: string) => fireEvent.change(view.getByLabelText(label, { exact: true }), { target: { value } });
  const reply = async (index: number, ok = true, body: Record<string, unknown> = {}) => {
    await waitFor(() => assert.ok(writes[index]), { timeout: 2000 });
    await act(async () => { writes[index].reply.resolve(Response.json(ok ? body : { error: 'Offline' }, { status: ok ? 200 : 500 })); });
  };
  return { view, writes, actions, deletions, mediaMutations, mediaItem, question, edit, reply, validations: () => validations };
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

for (const action of ['Export Quiz', 'Open lobby', 'Rehearse with devices']) {
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

const exitEditor = (e: Awaited<ReturnType<typeof editor>>) => fireEvent.click(e.view.getByText('← Quiz list'));
async function replyDelete(e: Awaited<ReturnType<typeof editor>>, ok = true) {
  await waitFor(() => assert.equal(e.deletions.length, 1));
  assert.equal(e.deletions[0].path, '/api/quizzes/q/rounds/r');
  await act(async () => { e.deletions[0].reply.resolve(ok ? new Response(null, { status: 204 }) : Response.json({ error: 'Delete failed' }, { status: 500 })); });
}

test('Quiz list waits for quiz, round and question saves and ignores duplicate exit clicks', async () => {
  const e = await editor();
  e.edit('Title', 'New quiz'); e.edit('Round title EN', 'New round'); e.edit('Question text EN', 'New question');
  const exit = e.view.getByText('← Quiz list');
  fireEvent.click(exit); fireEvent.click(exit);
  for (let index = 0; index < 3; index++) {
    assert.ok(e.view.queryByRole('heading', { name: 'Edit quiz' }));
    assert.ok(!e.view.queryByText('Quiz list opened'));
    await e.reply(index);
  }
  await waitFor(() => assert.ok(e.view.queryByText('Quiz list opened')));
  assert.equal(e.writes.length, 3);
});

test('failed exit save preserves visible draft, shows the error and allows retry', async () => {
  const e = await editor();
  e.edit('Question text EN', 'Keep this draft');
  exitEditor(e);
  await e.reply(0, false);
  assert.ok(!e.view.queryByText('Quiz list opened'));
  assert.equal((e.view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Keep this draft');
  assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Offline')));
  exitEditor(e);
  await e.reply(1);
  await waitFor(() => assert.ok(e.view.queryByText('Quiz list opened')));
});

test('blocked incomplete round prevents Quiz list navigation and preserves its draft', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Описание');
  exitEditor(e);
  await waitFor(() => assert.ok(e.view.queryAllByRole('alert').some(node => node.textContent?.includes('Complete both languages'))));
  assert.ok(!e.view.queryByText('Quiz list opened'));
  assert.equal((e.view.getByLabelText('Round description RU') as HTMLTextAreaElement).value, 'Описание');
  assert.equal(e.writes.length, 0);
});

test('confirmed incomplete round deletion discards its round/question drafts and clears global status', async () => {
  const e = await editor(false, true);
  e.edit('Round description RU', 'Описание');
  e.edit('Question text EN', 'Discard child');
  // A previously failed barrier must not leave a stale failed round queue.
  exitEditor(e);
  await e.reply(0, false);
  await waitFor(() => assert.ok(e.view.queryAllByRole('alert').length));
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await replyDelete(e);
  assert.equal(e.writes.length, 1, 'Deleted drafts must never be retried');
  assert.ok(!e.view.queryByRole('button', { name: 'Round / Раунд' }));
  await waitFor(() => assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved'));
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await waitFor(() => assert.equal(e.actions.length, 1));
  assert.equal(e.writes.length, 1);
});

test('round deletion preserves unrelated quiz save and waits for it', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Discard'); e.edit('Title', 'Keep quiz');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await waitFor(() => assert.equal(e.writes.length, 1));
  assert.equal(e.writes[0].path, '/api/quizzes/q');
  assert.equal(e.writes[0].body.title, 'Keep quiz');
  assert.equal(e.deletions.length, 0);
  await e.reply(0);
  await replyDelete(e);
  assert.ok(e.view.getByText('No rounds yet.'));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('failed unrelated save prevents DELETE and remains retryable', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Discard'); e.edit('Title', 'Keep quiz');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await e.reply(0, false);
  assert.equal(e.deletions.length, 0);
  assert.ok(e.view.getByRole('button', { name: 'Round / Раунд' }));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await e.reply(1);
  assert.equal(e.writes[1].body.title, 'Keep quiz');
  await replyDelete(e);
});

for (const target of ['round', 'question', 'option', 'pair'] as const) test(`${target} draft survives an unrelated failed save before DELETE`, async () => {
  const e = await editor(target === 'pair');
  const label = target === 'round' ? 'Round title EN' : target === 'question' ? 'Question text EN' : target === 'pair' ? 'Pair 1 left EN' : 'Option 1 EN';
  const button = target === 'round' ? 'Delete round' : target === 'question' ? 'Delete question' : target === 'pair' ? 'Delete pair 1' : 'Delete option 1';
  e.edit(label, 'Retained target');
  e.edit('Title', 'Unrelated quiz');
  fireEvent.click(e.view.getByRole('button', { name: button }));
  await e.reply(0, false);
  assert.equal(e.deletions.length, 0);
  assert.equal((e.view.getByLabelText(label) as HTMLInputElement).value, 'Retained target');
  assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(1);
  await e.reply(2);
  assert.ok(JSON.stringify(e.writes[2].body).includes('Retained target'));
  await waitFor(() => assert.equal(e.actions.length, 1));
  assert.equal(e.deletions.length, 0);
});

test('DELETE failure keeps the incomplete round visible with an error', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Keep visible');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await replyDelete(e, false);
  assert.ok(e.view.getByRole('button', { name: 'Round / Раунд' }));
  assert.equal((e.view.getByLabelText('Round description RU') as HTMLTextAreaElement).value, 'Keep visible');
  assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Delete failed')));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
});

test('failed round DELETE blocks parent actions without replay, survives autosave, and clears on explicit retry', async () => {
  const e = await editor();
  e.edit('Round description RU', 'Visible draft');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await replyDelete(e, false);
  for (const action of ['← Quiz list', 'Export Quiz', 'Open lobby', 'Rehearse with devices']) {
    fireEvent.click(e.view.getByRole('button', { name: action }));
    await act(async () => {});
    assert.equal(e.deletions.length, 1);
    assert.equal(e.actions.length, 0);
    assert.ok(!e.view.queryByText('Quiz list opened'));
  }
  e.edit('Round description EN', 'Saved draft');
  await e.reply(0);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  assert.equal((e.view.getByLabelText('Round description RU') as HTMLTextAreaElement).value, 'Visible draft');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await waitFor(() => assert.equal(e.deletions.length, 2));
  await act(async () => { e.deletions[1].reply.resolve(new Response(null, { status: 204 })); });
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('cancelled round confirmation leaves the barrier saved', async () => {
  const e = await editor();
  window.confirm = () => false;
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  assert.equal(e.deletions.length, 0);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

for (const succeeds of [true, false]) test(`round deletion waits for an in-flight save (${succeeds ? 'success' : 'failure'}) without replaying its replacement`, async () => {
  const e = await editor();
  e.edit('Round title EN', 'In flight');
  await waitFor(() => assert.equal(e.writes.length, 1), { timeout: 2000 });
  e.edit('Round title EN', 'Discard replacement');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  assert.equal(e.deletions.length, 0);
  await e.reply(0, succeeds);
  await replyDelete(e);
  assert.equal(e.writes.length, 1);
  assert.ok(e.view.getByText('No rounds yet.'));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('unrelated failure during an in-flight round PUT keeps its replacement draft', async () => {
  const e = await editor();
  e.edit('Round title EN', 'Older');
  await waitFor(() => assert.equal(e.writes.length, 1));
  e.edit('Round title EN', 'Replacement');
  e.edit('Title', 'Unrelated quiz');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete round' }));
  await e.reply(1, false);
  await e.reply(0);
  assert.equal(e.deletions.length, 0);
  assert.equal((e.view.getByLabelText('Round title EN') as HTMLInputElement).value, 'Replacement');
  fireEvent.click(e.view.getByRole('button', { name: 'Export Quiz' }));
  await e.reply(2);
  await e.reply(3);
  assert.ok(e.writes.slice(2, 4).some(write => write.body.titleEn === 'Replacement'));
  await waitFor(() => assert.equal(e.actions.length, 1));
  assert.equal(e.deletions.length, 0);
});

function GlobalSaveStatus() {
  const barrier = useSaveBarrier()!;
  return <output data-testid="global-save-status">{useSyncExternalStore(barrier.subscribe, barrier.snapshot)}</output>;
}

test('round deletion waits for another round question queue and preserves its failed draft', async () => {
  const e = await editor();
  cleanup();
  const view = render(<EditorSaves><GlobalSaveStatus /><Rounds quizId="q" /><Questions quizId="q" roundId="r2" /></EditorSaves>);
  await waitFor(() => assert.equal(view.getAllByLabelText('Question text EN').length, 2));
  const other = within(view.container.querySelectorAll('.questions')[1] as HTMLElement);
  fireEvent.change(view.getByLabelText('Round description RU'), { target: { value: 'Discard target' } });
  fireEvent.change(other.getByLabelText('Question text EN'), { target: { value: 'Other round draft' } });
  fireEvent.click(view.getByRole('button', { name: 'Delete round' }));
  await waitFor(() => assert.equal(e.writes.length, 1));
  assert.equal(e.writes[0].path, '/api/quizzes/q/rounds/r2/questions/a');
  assert.equal(e.deletions.length, 0);
  await e.reply(0, false);
  assert.equal(e.deletions.length, 0);
  assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed');
  assert.equal((other.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Other round draft');
  fireEvent.click(view.getByRole('button', { name: 'Delete round' }));
  await e.reply(1);
  assert.equal(e.writes[1].body.textEn, 'Other round draft');
  await replyDelete(e);
  assert.ok(view.getByText('No rounds yet.'));
  assert.equal(view.getByTestId('global-save-status').textContent, 'Saved');
});

test('targeted discard preserves a different round draft in the same queue', async () => {
  let saves!: ReturnType<typeof useEditorSave>;
  let barrier!: NonNullable<ReturnType<typeof useSaveBarrier>>;
  const persisted: string[] = [];
  function Drafts() {
    saves = useEditorSave(); barrier = useSaveBarrier()!;
    return <GlobalSaveStatus />;
  }
  const view = render(<EditorSaves><Drafts /></EditorSaves>);
  await act(async () => {
    saves.schedule('r', async () => { persisted.push('r'); }, 'Incomplete target', 'r');
    saves.schedule('r2', async () => { persisted.push('r2'); }, 'Incomplete other round', 'r2');
    barrier.discard('r');
    await assert.rejects(barrier.flush(), /Incomplete other round/);
  });
  assert.equal(persisted.length, 0);
  assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed');
  await act(async () => {
    saves.schedule('r2', async () => { persisted.push('r2'); }, undefined, 'r2');
    await barrier.flush();
  });
  assert.deepEqual(persisted, ['r2']);
  assert.equal(view.getByTestId('global-save-status').textContent, 'Saved');
});

async function deleteQuestionReply(e: Awaited<ReturnType<typeof editor>>, ok = true) {
  await waitFor(() => assert.equal(e.deletions.length, 1));
  assert.equal(e.deletions[0].path, '/api/quizzes/q/rounds/r/questions/a');
  await act(async () => { e.deletions[0].reply.resolve(ok ? new Response(null, { status: 204 }) : Response.json({ error: 'Delete failed' }, { status: 500 })); });
}

for (const matching of [false, true]) test(`question deletion discards failed points and pending ${matching ? 'pair' : 'option'} edits`, async () => {
  const e = await editor(matching);
  e.edit('Points', '0');
  e.edit(matching ? 'Pair 1 left EN' : 'Option 1 EN', 'Discard child');
  await e.reply(0, false);
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await deleteQuestionReply(e);
  assert.equal(e.writes.length, 1);
  assert.ok(e.view.getByText('No questions yet.'));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('failed question DELETE keeps the question visible and reports failure', async () => {
  const e = await editor();
  e.edit('Points', '0');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await deleteQuestionReply(e, false);
  assert.ok(e.view.getByLabelText('Points'));
  assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Delete failed')));
});

test('failed question DELETE blocks Quiz list without replay and clears on retry', async () => {
  const e = await editor();
  e.edit('Points', '0');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await deleteQuestionReply(e, false);
  exitEditor(e);
  await e.reply(0, false);
  assert.equal(e.deletions.length, 1);
  assert.ok(!e.view.queryByText('Quiz list opened'));
  assert.equal((e.view.getByLabelText('Points') as HTMLInputElement).value, '0');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await waitFor(() => assert.equal(e.deletions.length, 2));
  await act(async () => { e.deletions[1].reply.resolve(new Response(null, { status: 204 })); });
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('cancelled question confirmation leaves the barrier saved', async () => {
  const e = await editor();
  window.confirm = () => false;
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  assert.equal(e.deletions.length, 0);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

for (const succeeds of [true, false]) test(`question deletion waits for target PUT (${succeeds}) without replaying replacement`, async () => {
  const e = await editor();
  e.edit('Question text EN', 'In flight');
  await waitFor(() => assert.equal(e.writes.length, 1));
  e.edit('Question text EN', 'Discard replacement');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  assert.equal(e.deletions.length, 0);
  await e.reply(0, succeeds);
  await deleteQuestionReply(e);
  assert.equal(e.writes.length, 1);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

test('question deletion waits for quiz and round settings and preserves their failures', async () => {
  const e = await editor();
  e.edit('Points', '0'); e.edit('Title', 'Keep quiz'); e.edit('Round title EN', 'Keep round');
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await e.reply(0, false); await e.reply(1);
  assert.equal(e.deletions.length, 0);
  assert.ok(e.writes.every(write => !write.path.includes('/questions/')));
  fireEvent.click(e.view.getByRole('button', { name: 'Delete question' }));
  await e.reply(2);
  assert.equal(e.writes[2].body.title, 'Keep quiz');
  await deleteQuestionReply(e);
});

for (const matching of [false, true]) test(`deleting a ${matching ? 'pair' : 'option'} discards only its own failed edit`, async () => {
  const e = await editor(matching);
  e.edit(matching ? 'Pair 1 left EN' : 'Option 1 EN', 'Discard');
  await e.reply(0, false);
  e.edit('Question text EN', 'Keep question');
  fireEvent.click(e.view.getByRole('button', { name: matching ? 'Delete pair 1' : 'Delete option 1' }));
  await e.reply(1);
  assert.equal(e.writes[1].body.textEn, 'Keep question');
  await waitFor(() => assert.equal(e.deletions.length, 1));
  assert.ok(e.deletions[0].path.endsWith(matching ? '/pairs/p' : '/options/o'));
  await act(async () => { e.deletions[0].reply.resolve(new Response(null, { status: 204 })); });
  assert.equal(e.writes.length, 2);
  assert.ok(!e.view.queryByLabelText(matching ? 'Pair 1 left EN' : 'Option 1 EN'));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

for (const matching of [false, true]) test(`failed ${matching ? 'pair' : 'option'} DELETE blocks parent actions and clears only on retry`, async () => {
  const e = await editor(matching);
  const label = matching ? 'Pair 1 left EN' : 'Option 1 EN';
  e.edit(label, 'Visible draft');
  fireEvent.click(e.view.getByRole('button', { name: matching ? 'Delete pair 1' : 'Delete option 1' }));
  await waitFor(() => assert.equal(e.deletions.length, 1));
  await act(async () => { e.deletions[0].reply.resolve(Response.json({ error: 'Delete failed' }, { status: 500 })); });
  e.edit('Question text EN', 'Unrelated save');
  await e.reply(0);
  assert.ok(e.writes[0].path.endsWith(matching ? '/pairs/p' : '/options/o'));
  await e.reply(1);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: '← Quiz list' }));
  await act(async () => {});
  assert.equal(e.deletions.length, 1);
  assert.equal(e.actions.length, 0);
  assert.equal((e.view.getByLabelText(label) as HTMLInputElement).value, 'Visible draft');
  await waitFor(() => assert.equal((e.view.getByRole('button', { name: '← Quiz list' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(e.view.getByRole('button', { name: matching ? 'Delete pair 1' : 'Delete option 1' }));
  await waitFor(() => assert.equal(e.deletions.length, 2));
  await act(async () => { e.deletions[1].reply.resolve(new Response(null, { status: 204 })); });
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
});

for (const matching of [false, true]) test(`successful type conversion clears obsolete ${matching ? 'pair' : 'option'} DELETE failure`, async () => {
  const e = await editor(matching);
  fireEvent.click(e.view.getByRole('button', { name: matching ? 'Delete pair 1' : 'Delete option 1' }));
  await waitFor(() => assert.equal(e.deletions.length, 1));
  await act(async () => e.deletions[0].reply.resolve(Response.json({ error: 'Delete failed' }, { status: 500 })));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.change(e.view.getByLabelText('Question type'), { target: { value: matching ? 'single_choice' : 'matching' } });
  await e.reply(0, true, { ...e.question, type: matching ? 'single_choice' : 'matching' });
  await waitFor(() => assert.equal((e.view.getByLabelText('Question type') as HTMLSelectElement).value, matching ? 'single_choice' : 'matching'));
  await waitFor(() => assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved'));
  fireEvent.click(e.view.getByRole('button', { name: '← Quiz list' }));
  await waitFor(() => assert.ok(e.view.getByText('Quiz list opened')));
});

test('unrelated media failure blocks answer-structure conversion', async () => {
  const e = await editor();
  await startMedia(e, 'delete');
  await replyMedia(e, 0, false);
  fireEvent.change(e.view.getByLabelText('Question type'), { target: { value: 'matching' } });
  await act(async () => {});
  assert.equal(e.writes.length, 0);
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
});

test('clearing removed option failures preserves unrelated operation failures', async () => {
  let saves!: ReturnType<typeof useEditorSave>;
  let barrier!: NonNullable<ReturnType<typeof useSaveBarrier>>;
  function Status() { saves = useEditorSave(); barrier = useSaveBarrier()!; return <GlobalSaveStatus />; }
  const view = render(<EditorSaves><Status /></EditorSaves>);
  await act(async () => {
    await assert.rejects(saves.perform(async () => { throw new Error('Option delete failed'); }, 'option', false, 'r/questions/a/options/o'));
    await assert.rejects(saves.perform(async () => { throw new Error('Media delete failed'); }, 'media'));
    saves.discard('r/questions/a/options');
  });
  assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed');
  await assert.rejects(barrier.flush(), /Media delete failed/);
});

test('failed type switch retains existing child DELETE failure', async () => {
  const e = await editor();
  fireEvent.click(e.view.getByRole('button', { name: 'Delete option 1' }));
  await waitFor(() => assert.equal(e.deletions.length, 1));
  await act(async () => e.deletions[0].reply.resolve(Response.json({ error: 'Delete failed' }, { status: 500 })));
  fireEvent.change(e.view.getByLabelText('Question type'), { target: { value: 'matching' } });
  await e.reply(0, false);
  assert.equal((e.view.getByLabelText('Question type') as HTMLSelectElement).value, 'single_choice');
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: '← Quiz list' }));
  await act(async () => {});
  assert.ok(!e.view.queryByText('Quiz list opened'));
});

test('non-structural type switch does not clear a retained option DELETE failure', async () => {
  const e = await editor();
  fireEvent.click(e.view.getByRole('button', { name: 'Delete option 1' }));
  await waitFor(() => assert.equal(e.deletions.length, 1));
  await act(async () => e.deletions[0].reply.resolve(Response.json({ error: 'Delete failed' }, { status: 500 })));
  fireEvent.change(e.view.getByLabelText('Question type'), { target: { value: 'multiple_choice' } });
  await e.reply(0, true, { ...e.question, type: 'multiple_choice' });
  await waitFor(() => assert.equal((e.view.getByLabelText('Question type') as HTMLSelectElement).value, 'multiple_choice'));
  assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
  fireEvent.click(e.view.getByRole('button', { name: '← Quiz list' }));
  await act(async () => {});
  assert.ok(!e.view.queryByText('Quiz list opened'));
});

for (const outcome of ['success', 'retained failure', 'unrelated failure', 'failed PUT', 'retry GET'] as const) {
  test(`Yes / No normalization reconciles deleted option ownership: ${outcome}`, async () => {
    const originalFetch = globalThis.fetch;
    const base = '/api/quizzes/q/rounds/r/questions';
    let question: Question = { id: 'a', roundId: 'r', type: 'multiple_choice', textRu: '', textEn: '', points: 1,
      answerTimeSeconds: null, showOptionsOnScreen: false, position: 0, createdAt: '', updatedAt: '' };
    let options: Option[] = [1, 2, 3].map((number, position) => ({ id: `o${number}`, questionId: 'a',
      textRu: `Ответ ${number}`, textEn: `Answer ${number}`, isCorrect: number < 3, position, createdAt: '', updatedAt: '' }));
    let failReload = outcome === 'retry GET';
    let typePuts = 0;
    let saves!: ReturnType<typeof useEditorSave>;
    let barrier!: NonNullable<ReturnType<typeof useSaveBarrier>>;
    function Probe() { saves = useEditorSave(); barrier = useSaveBarrier()!; return <GlobalSaveStatus />; }
    globalThis.fetch = async (input, init) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === base && method === 'GET') return Response.json([question]);
      if (path === `${base}/a/options` && method === 'GET') {
        if (question.type === 'yes_no' && failReload) { failReload = false; return Response.json({ error: 'Reload failed' }, { status: 500 }); }
        return Response.json(options);
      }
      if (path.startsWith(`${base}/a/options/`) && method === 'DELETE') return Response.json({ error: `Delete ${path.split('/').at(-1)} failed` }, { status: 500 });
      if (path === `${base}/a` && method === 'PUT') {
        typePuts++;
        if (outcome === 'failed PUT') return Response.json({ error: 'Type failed' }, { status: 500 });
        question = { ...question, ...JSON.parse(String(init!.body)) };
        options = options.slice(0, 2).map((option, index) => ({ ...option, isCorrect: index === 0 }));
        return Response.json(question);
      }
      throw new Error(`Unexpected ${method} ${path}`);
    };
    try {
      const view = render(<EditorSaves><Probe /><Questions quizId="q" roundId="r" /></EditorSaves>);
      await waitFor(() => assert.ok(view.getByLabelText('Option 3 EN')));
      fireEvent.click(view.getByRole('button', { name: 'Delete option 3' }));
      await waitFor(() => assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed'));
      assert.equal(options.length, 3, 'failed DELETE did not remove the server child');
      if (outcome === 'retained failure') await act(async () => {
        await assert.rejects(saves.perform(async () => { throw new Error('Delete o1 failed'); }, 'retained', false, 'r/questions/a/options/o1'));
      });
      if (outcome === 'unrelated failure') await act(async () => {
        await assert.rejects(saves.perform(async () => { throw new Error('Other question failed'); }, 'other', false, 'r/questions/b/options/o3'));
      });
      fireEvent.change(view.getByLabelText('Question type'), { target: { value: 'yes_no' } });
      if (outcome === 'failed PUT') {
        await waitFor(() => {
          assert.equal(typePuts, 1);
          assert.equal((view.getByLabelText('Question type') as HTMLSelectElement).disabled, false);
        });
        assert.equal((view.getByLabelText('Question type') as HTMLSelectElement).value, 'multiple_choice');
        assert.ok(view.getByLabelText('Option 3 EN'));
        await assert.rejects(barrier.flush(), /Delete o3 failed/);
      } else {
        if (outcome === 'retry GET') {
          await waitFor(() => assert.ok(view.getByRole('button', { name: 'Try loading answers again' })));
          await assert.rejects(barrier.flush(), /Delete o3 failed/);
          fireEvent.click(view.getByRole('button', { name: 'Try loading answers again' }));
        }
        await waitFor(() => assert.ok(view.getByLabelText('Option 2 EN')));
        assert.equal(view.queryByLabelText('Option 3 EN'), null);
        assert.deepEqual(options.map(option => option.id), ['o1', 'o2']);
        if (outcome === 'retained failure' || outcome === 'unrelated failure') {
          await assert.rejects(barrier.flush(), outcome === 'retained failure' ? /Delete o1 failed/ : /Other question failed/);
          if (outcome === 'unrelated failure') await act(async () => {
            const release = await barrier.flushExcept('r/questions/b'); release();
          });
          assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed');
        } else {
          await act(async () => barrier.flush());
          assert.equal(view.getByTestId('global-save-status').textContent, 'Saved');
        }
      }
    } finally { cleanup(); globalThis.fetch = originalFetch; }
  });
}

test('child identity reconciliation retires only absent child work across save queues', async () => {
  let saves!: ReturnType<typeof useEditorSave>;
  let otherSaves!: ReturnType<typeof useEditorSave>;
  let barrier!: NonNullable<ReturnType<typeof useSaveBarrier>>;
  const persisted: string[] = [];
  const owner = 'r/questions/a/options';
  function Drafts() { saves = useEditorSave(); otherSaves = useEditorSave(); barrier = useSaveBarrier()!; return <GlobalSaveStatus />; }
  render(<EditorSaves><Drafts /></EditorSaves>);
  await act(async () => {
    await assert.rejects(saves.perform(async () => { throw new Error('Absent child failed'); }, 'absent', false, `${owner}/o3`));
    await assert.rejects(otherSaves.perform(async () => { throw new Error('Retained child failed'); }, 'retained', false, `${owner}/o1`));
    await assert.rejects(otherSaves.perform(async () => { throw new Error('Other collection failed'); }, 'other', false, `${owner}-other/o3`));
    saves.schedule('absent draft', async () => { persisted.push('absent'); }, 'Absent draft blocked', `${owner}/o3/text`);
    saves.schedule('retained draft', async () => { persisted.push('retained'); }, undefined, `${owner}/o1`);
    barrier.reconcileChildren(owner, ['o1', 'o2']);
    await assert.rejects(barrier.flush(), /Retained child failed/);
    await otherSaves.perform(async () => {}, 'retained');
    await assert.rejects(barrier.flush(), /Other collection failed/);
    await otherSaves.perform(async () => {}, 'other');
    await barrier.flush();
  });
  assert.deepEqual(persisted, ['retained']);
});

test('question owner discard retains another question in the same queue', async () => {
  let saves!: ReturnType<typeof useEditorSave>;
  let barrier!: NonNullable<ReturnType<typeof useSaveBarrier>>;
  const persisted: string[] = [];
  function Drafts() { saves = useEditorSave(); barrier = useSaveBarrier()!; return <GlobalSaveStatus />; }
  const view = render(<EditorSaves><Drafts /></EditorSaves>);
  await act(async () => {
    saves.schedule('a', async () => { persisted.push('a'); }, 'Invalid target', 'r/questions/a');
    saves.schedule('o', async () => { persisted.push('o'); }, undefined, 'r/questions/a/options/o');
    saves.schedule('b', async () => { persisted.push('b'); throw new Error('Other question failed'); }, undefined, 'r/questions/b');
    barrier.discard('r/questions/a');
    await assert.rejects(barrier.flush(), /Other question failed/);
  });
  assert.deepEqual(persisted, ['b']);
  assert.equal(view.getByTestId('global-save-status').textContent, 'Save failed');
  await act(async () => {
    saves.schedule('b', async () => { persisted.push('b retry'); }, undefined, 'r/questions/b');
    await barrier.flush();
  });
  assert.deepEqual(persisted, ['b', 'b retry']);
});

async function startMedia(e: Awaited<ReturnType<typeof editor>>, mutation: 'upload' | 'delete') {
  if (e.view.queryByRole('button', { name: 'Manage media' })) fireEvent.click(e.view.getByRole('button', { name: 'Manage media' }));
  await waitFor(() => assert.ok(e.view.getByText('picture.gif')));
  if (mutation === 'upload') {
    fireEvent.change(e.view.getByLabelText('Media file'), { target: { files: [new File(['GIF89a'], 'picture.gif', { type: 'image/gif' })] } });
    fireEvent.click(e.view.getByRole('button', { name: 'Upload media' }));
  } else fireEvent.click(e.view.getByRole('button', { name: 'Delete media picture.gif' }));
}
async function replyMedia(e: Awaited<ReturnType<typeof editor>>, index: number, ok = true) {
  await waitFor(() => assert.ok(e.mediaMutations[index]));
  await act(async () => { e.mediaMutations[index].reply.resolve(ok
    ? e.mediaMutations[index].method === 'POST' ? Response.json({ ...e.mediaItem, id: 'uploaded' }) : new Response(null, { status: 204 })
    : Response.json({ error: 'Media unavailable' }, { status: 500 })); });
}

for (const mutation of ['upload', 'delete'] as const) {
  for (const action of ['Export Quiz', 'Open lobby', 'Rehearse with devices', '← Quiz list']) test(`${action} waits for media ${mutation} and locks further mutations`, async () => {
    const e = await editor();
    const initial = e.validations();
    await startMedia(e, mutation);
    await waitFor(() => assert.equal(e.mediaMutations.length, 1));
    fireEvent.click(e.view.getByRole('button', { name: action }));
    await act(async () => {});
    assert.equal(e.actions.length, 0);
    assert.ok(!e.view.queryByText('Quiz list opened'));
    assert.ok(!e.view.queryByText('Lobby opened'));
    assert.ok(e.view.getByRole('button', { name: 'Upload media' }).matches(':disabled'));
    assert.notEqual(e.view.getAllByRole('status')[0].textContent, 'Saved');
    await replyMedia(e, 0);
    await waitFor(() => action === '← Quiz list' ? assert.ok(e.view.getByText('Quiz list opened')) : assert.equal(e.actions.length, 1));
    assert.ok(e.validations() > initial);
    if (action === 'Export Quiz') assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
  });
  test(`failed media ${mutation} blocks repeated Quiz list attempts without replay until explicit retry succeeds`, async () => {
    const e = await editor();
    const initial = e.validations();
    await startMedia(e, mutation);
    exitEditor(e);
    await replyMedia(e, 0, false);
    assert.ok(e.view.getByRole('heading', { name: 'Edit quiz' }));
    assert.ok(e.view.getAllByRole('alert').some(node => node.textContent?.includes('Media unavailable')));
    exitEditor(e);
    await act(async () => {});
    assert.ok(!e.view.queryByText('Quiz list opened'));
    assert.equal(e.mediaMutations.length, 1);
    assert.equal(e.validations(), initial);
    assert.equal(e.view.getAllByRole('status')[0].textContent, 'Save failed');
    await startMedia(e, mutation);
    await replyMedia(e, 1);
    assert.equal(e.view.getAllByRole('status')[0].textContent, 'Saved');
    assert.ok(e.validations() > initial);
    exitEditor(e);
    await waitFor(() => assert.ok(e.view.getByText('Quiz list opened')));
  });
}

for (const action of ['Export Quiz', 'Open lobby', 'Rehearse with devices', '← Quiz list']) test(`${action} prevents starting media mutations while waiting for other saves`, async () => {
  const e = await editor();
  fireEvent.click(e.view.getByRole('button', { name: 'Manage media' }));
  await waitFor(() => assert.ok(e.view.getByText('picture.gif')));
  fireEvent.change(e.view.getByLabelText('Media file'), { target: { files: [new File(['GIF89a'], 'picture.gif')] } });
  e.edit('Title', 'Pending settings');
  fireEvent.click(e.view.getByRole('button', { name: action }));
  const upload = e.view.getByRole('button', { name: 'Upload media' });
  const remove = e.view.getByRole('button', { name: 'Delete media picture.gif' });
  assert.ok(upload.matches(':disabled') && remove.matches(':disabled'));
  fireEvent.click(upload); fireEvent.click(remove);
  assert.equal(e.mediaMutations.length, 0);
  await e.reply(0);
  await waitFor(() => action === '← Quiz list' ? assert.ok(e.view.getByText('Quiz list opened')) : assert.equal(e.actions.length, 1));
});
