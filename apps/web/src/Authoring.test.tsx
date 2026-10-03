import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QuizEditor, QuizList } from './Admin';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const quiz = { id: 'quiz', title: 'Party quiz', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
const round = (id: string) => ({ id, quizId: quiz.id, titleRu: `Раунд ${id}`, titleEn: `Round ${id}`, descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 });
const question = (id: string, roundId = 'first', type = 'single_choice') => ({ id, roundId, type, textRu: `Вопрос ${id}`, textEn: `Question ${id}`, points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, media: [] as { mediaId: string; playBeforeTimer: boolean }[], position: 0 });
function showEditor() {
  return render(<MemoryRouter initialEntries={['/admin/quizzes/quiz']}><Routes>
    <Route path="/admin/quizzes/:quizId" element={<QuizEditor />} />
    <Route path="/host/:roomId" element={<p>Lobby opened</p>} />
  </Routes></MemoryRouter>);
}

test('round navigation includes its questions and keeps preview open after saving and changing rounds', async () => {
  let reply!: (response: Response) => void;
  let pending = false;
  const first = question('one');
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') {
      assert.equal(path, '/api/quizzes/quiz/rounds/first/questions/one');
      assert.equal(JSON.parse(String(init.body)).textEn, 'Latest edit');
      pending = true;
      return new Promise(done => { reply = done; });
    }
    if (path.endsWith('/validation')) return Response.json({ ready: true, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([round('first'), round('second')]);
    if (path.endsWith('/questions')) return Response.json(path.includes('/first/') ? [first, question('two')] : [question('three', 'second')]);
    if (path.endsWith('/options') || path.endsWith('/media')) return Response.json([]);
    return Response.json(quiz);
  };
  const view = showEditor();
  await waitFor(() => assert.ok(view.getByLabelText('Question text EN')));
  const tree = within(view.getByRole('navigation', { name: 'Rounds' }));
  fireEvent.click(tree.getByRole('button', { name: '2. Question two' }));
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Question two'));
  fireEvent.click(tree.getByRole('button', { name: '1. Question one' }));
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Question one'));
  fireEvent.click(view.getByRole('button', { name: 'Preview question' }));
  assert.equal(view.getByRole('button', { name: 'Preview question' }).getAttribute('aria-expanded'), 'true');
  assert.equal(view.getByRole('region', { name: 'Question preview' }).closest('.selected-question-content'), null);
  fireEvent.change(view.getByLabelText('Preview mode'), { target: { value: 'EN Player' } });
  fireEvent.click(tree.getByRole('button', { name: '2. Question two' }));
  await waitFor(() => assert.ok(within(view.getByRole('region', { name: 'Question preview' })).getByText('Question two')));
  assert.equal((view.getByLabelText('Preview mode') as HTMLSelectElement).value, 'EN Player');
  fireEvent.click(tree.getByRole('button', { name: '1. Question one' }));
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Question one'));
  fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Latest edit' } });
  fireEvent.click(tree.getByRole('button', { name: 'Round second / Раунд second' }));
  await waitFor(() => assert.ok(pending));
  assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Latest edit');
  await act(async () => reply(Response.json({ ...first, textEn: 'Latest edit' })));
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Question three'));
  assert.ok(within(view.getByRole('region', { name: 'Question preview' })).getByText('Вопрос three'));
  assert.equal(tree.getByRole('button', { name: '1. Question three' }).getAttribute('aria-current'), 'true');
  fireEvent.click(view.getByRole('button', { name: 'Close preview' }));
  assert.equal(view.queryByRole('region', { name: 'Question preview' }), null);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Preview question' }));
});

test('compact Add question offers all four types and selects each new question for editing and preview', async () => {
  const questions: ReturnType<typeof question>[] = [];
  const created: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([round('first')]);
    if (path.endsWith('/questions')) {
      if (init?.method === 'POST') {
        const type = init.body ? JSON.parse(String(init.body)).type : 'single_choice';
        const item = question(String(questions.length + 1), 'first', type);
        created.push(type); questions.push(item); return Response.json(item);
      }
      return Response.json(questions);
    }
    if (path.endsWith('/media') || path.endsWith('/options') || path.endsWith('/pairs')) return Response.json([]);
    return Response.json(quiz);
  };
  const view = showEditor();
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Add question' })));
  const picker = view.getByLabelText('New question type') as HTMLSelectElement;
  assert.equal(picker.options.length, 4);
  for (const type of ['single_choice', 'yes_no', 'multiple_choice', 'matching']) {
    fireEvent.change(picker, { target: { value: type } });
    fireEvent.click(view.getByRole('button', { name: 'Add question' }));
    await waitFor(() => assert.equal((view.getByLabelText('Question type') as HTMLSelectElement).value, type));
    const navigation = within(view.getByRole('navigation', { name: 'Questions' }));
    assert.equal(navigation.getByRole('button', { name: `${questions.length}. Question ${questions.length}` }).getAttribute('aria-current'), 'true');
    fireEvent.click(view.getByRole('button', { name: 'Preview question' }));
    assert.ok(within(view.getByRole('region', { name: 'Question preview' })).getByText(`Вопрос ${questions.length}`));
    fireEvent.click(view.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Add question' }) as HTMLButtonElement).disabled, false));
  }
  assert.deepEqual(created, ['single_choice', 'yes_no', 'multiple_choice', 'matching']);
});

test('readiness selects the affected round, question and answer after waiting for current edits', async () => {
  const first = question('one');
  const second = question('two', 'second');
  const third = question('three', 'second');
  let resolveSave!: (response: Response) => void;
  let saving = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') { saving = true; return new Promise(done => { resolveSave = done; }); }
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'OPTION_TEXT_EN_MISSING', message: 'Option 1 in Question 2 is missing English text', roundId: 'second', questionId: 'three', optionId: 'answer' }] });
    if (path.endsWith('/rounds')) return Response.json([round('first'), round('second')]);
    if (path.endsWith('/questions')) return Response.json(path.includes('/first/') ? [first] : [second, third]);
    if (path.endsWith('/options')) return Response.json([{ id: 'answer', questionId: path.includes('/three/') ? 'three' : path.includes('/two/') ? 'two' : 'one', textRu: 'Ответ', textEn: '', isCorrect: true, position: 0 }]);
    if (path.endsWith('/media')) return Response.json([]);
    return Response.json(quiz);
  };
  const view = showEditor();
  await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
  fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Unsaved edit' } });
  fireEvent.click(view.getByText('Show problems'));
  fireEvent.click(view.getByRole('button', { name: 'Option 1 in Question 2 is missing English text' }));
  await waitFor(() => assert.ok(saving));
  assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Unsaved edit');
  assert.equal(view.getByRole('button', { name: 'Round first / Раунд first' }).getAttribute('aria-current'), 'true');
  await act(async () => resolveSave(Response.json(first)));
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Question three'));
  assert.equal(view.getByRole('button', { name: 'Round second / Раунд second' }).getAttribute('aria-current'), 'true');
  assert.equal(view.getByRole('button', { name: '2. Question three' }).getAttribute('aria-current'), 'true');
  assert.ok(view.getByLabelText('Round has problems'));
  assert.ok(within(view.getByRole('navigation', { name: 'Questions' })).getByLabelText('Question has problems').getAttribute('title')?.includes('missing English text'));
  await waitFor(() => assert.equal((document.activeElement as HTMLElement).dataset.authoringItem, 'answer'));
  fireEvent.click(view.getByRole('button', { name: 'Preview question' }));
  assert.ok(within(view.getByRole('region', { name: 'Question preview' })).getByText('Вопрос three'));
});

test('upload automatically updates question, Matching and round-art selectors; unavailable attachment shows no UUID', async () => {
  const missing = '91a9231c-b835-46fa-9d4e-8c969885aaef';
  const current = { ...question('one', 'first', 'matching'), media: [{ mediaId: missing, playBeforeTimer: false }] };
  const media: { id: string; name: string; kind: string; sizeBytes: number }[] = [];
  const pair = { id: 'pair', questionId: 'one', left: { kind: 'text', textRu: 'Кот', textEn: 'Cat' }, right: { kind: 'text', textRu: 'Ответ', textEn: 'Answer' }, position: 0 };
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/media')) {
      if (init?.method === 'POST') { const item = { id: 'new-media', name: 'picture.png', kind: 'image', sizeBytes: 100 }; media.push(item); return Response.json(item); }
      return Response.json(media);
    }
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([round('first')]);
    if (path.endsWith('/questions')) return Response.json([current]);
    if (path.endsWith('/pairs')) return Response.json([pair]);
    if (init?.method === 'PUT') { Object.assign(current, JSON.parse(String(init.body))); return Response.json(current); }
    return Response.json(quiz);
  };
  const view = showEditor();
  await waitFor(() => assert.ok(view.getByLabelText('Pair 1 left kind')));
  assert.ok(view.getByText('Attached file unavailable — remove it or choose another'));
  assert.equal(view.container.textContent?.includes(missing), false);
  assert.equal(view.queryByRole('button', { name: /Load \/ refresh/ }), null);
  fireEvent.click(view.getByRole('button', { name: 'Manage media' }));
  await waitFor(() => assert.ok(view.getByText('No media uploaded.')));
  fireEvent.change(view.getByLabelText('Media file'), { target: { files: [new File(['png'], 'picture.png', { type: 'image/png' })] } });
  fireEvent.click(view.getByRole('button', { name: 'Upload media' }));
  await waitFor(() => assert.ok(within(view.getByLabelText('Attach question media')).getByRole('option', { name: 'picture.png (image)' })));
  assert.ok(within(view.getByLabelText('Round art')).getByRole('option', { name: 'picture.png (image)', hidden: true }));
  assert.equal((within(view.getByLabelText('Pair 1 left kind')).getByRole('option', { name: 'Image' }) as HTMLOptionElement).disabled, false);
  fireEvent.change(view.getByLabelText('Attach question media'), { target: { value: 'new-media' } });
  await waitFor(() => assert.equal(current.media.length, 2));
  assert.ok(view.getByText('picture.png (image)', { selector: 'strong' }));
  fireEvent.change(view.getByLabelText('Pair 1 left kind'), { target: { value: 'image' } });
  await waitFor(() => assert.ok(view.getByLabelText('Pair 1 left image')));
  assert.ok(within(view.getByLabelText('Pair 1 left image')).getByRole('option', { name: 'picture.png' }));
});

test('readiness for the selected question preserves its in-flight answer load', async () => {
  let resolveAnswers!: (response: Response) => void;
  let answerLoads = 0;
  globalThis.fetch = async input => {
    const path = String(input);
    if (path.endsWith('/validation')) return Response.json({ ready: false, problems: [{ code: 'OPTION_TEXT_EN_MISSING', message: 'Option 1 needs English text', roundId: 'first', questionId: 'one', optionId: 'answer' }] });
    if (path.endsWith('/rounds')) return Response.json([round('first')]);
    if (path.endsWith('/questions')) return Response.json([question('one')]);
    if (path.endsWith('/options')) { answerLoads++; return new Promise(done => { resolveAnswers = done; }); }
    if (path.endsWith('/media')) return Response.json([]);
    return Response.json(quiz);
  };
  const view = showEditor();
  await waitFor(() => assert.ok(view.getByLabelText('Question text EN')));
  assert.ok(resolveAnswers);
  fireEvent.click(view.getByText('Show problems'));
  fireEvent.click(view.getByRole('button', { name: 'Option 1 needs English text' }));
  await act(async () => {});
  await act(async () => resolveAnswers(Response.json([{ id: 'answer', questionId: 'one', textRu: 'Ответ', textEn: '', isCorrect: true, position: 0 }])));
  await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
  assert.equal(answerLoads, 1);
  assert.equal(view.getByRole('button', { name: '1. Question one' }).getAttribute('aria-current'), 'true');
});

test('Admin makes Edit and Play primary while retaining confirmed deletion and secondary actions', async () => {
  const calls: string[] = [];
  let confirmed = false;
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json([quiz]);
  };
  const view = render(<MemoryRouter><QuizList /></MemoryRouter>);
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'Edit Party quiz' })));
  assert.ok(view.getByRole('heading', { name: 'My quizzes' }));
  assert.ok(view.getByRole('button', { name: 'Play Party quiz' }));
  for (const name of ['Duplicate Party quiz', 'Export Party quiz', 'Delete Party quiz', 'Import Quiz']) assert.equal(view.getByRole('button', { name, hidden: true }).closest('details')?.open, false);
  fireEvent.click(view.getByText('More'));
  for (const name of ['Duplicate Party quiz', 'Export Party quiz', 'Delete Party quiz']) assert.ok(view.getByRole('button', { name }));
  fireEvent.click(view.getByRole('button', { name: 'Delete Party quiz' }));
  assert.equal(calls.filter(call => call.startsWith('DELETE')).length, 0);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Delete Party quiz' }));
  await waitFor(() => assert.ok(!view.queryByRole('link', { name: 'Edit Party quiz' })));
  assert.equal(calls.filter(call => call.startsWith('DELETE')).length, 1);
});
