import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorSaves } from './EditorSaves';
import { Questions } from './Questions';
import { Rounds } from './Rounds';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const source = { id: 'one', roundId: 'round', type: 'single_choice', textRu: 'Вопрос', textEn: '', points: 1, answerTimeSeconds: null, position: 0, media: [] as { mediaId: string; playBeforeTimer: boolean }[] };
const answers = [{ id: 'a', questionId: 'one', textRu: 'Ответ', textEn: '', isCorrect: false, position: 0 },
  { id: 'b', questionId: 'one', textRu: 'Другой', textEn: 'Other', isCorrect: false, position: 1 }];

test('field hints follow live edits and correctness, allowing media-only questions', async () => {
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/questions')) return Response.json([source]);
    if (path.endsWith('/options')) return Response.json(answers);
    if (path.endsWith('/correct')) return Response.json(answers.map(answer => ({ ...answer, isCorrect: answer.id === 'a' })));
    if (path.endsWith('/media')) return Response.json([{ id: 'image', name: 'image.png', kind: 'image' }]);
    return Response.json({ ...source, ...JSON.parse(String(init?.body ?? '{}')) });
  };
  const view = render(<Questions quizId="quiz" roundId="round" />);
  await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
  const english = view.getByLabelText('Question text EN');
  assert.equal(english.getAttribute('aria-invalid'), 'true');
  assert.match(document.getElementById(english.getAttribute('aria-describedby')!)!.textContent!, /English/);
  fireEvent.change(english, { target: { value: 'Question' } });
  assert.equal(english.getAttribute('aria-invalid'), null);
  const option = view.getByLabelText('Option 1 EN');
  assert.equal(option.getAttribute('aria-invalid'), 'true');
  fireEvent.change(option, { target: { value: 'Answer' } });
  assert.equal(option.getAttribute('aria-invalid'), null);
  assert.ok(view.getByText('Choose exactly one correct answer.'));
  fireEvent.click(view.getByLabelText('Correct answer, option 1'));
  await waitFor(() => assert.equal(Boolean(view.queryByText('Choose exactly one correct answer.')), false, 'Correct-answer hint cleared'));
  fireEvent.change(view.getByLabelText('Attach question media'), { target: { value: 'image' } });
  fireEvent.change(view.getByLabelText('Question text RU'), { target: { value: '' } });
  fireEvent.change(english, { target: { value: '' } });
  assert.equal(english.getAttribute('aria-invalid'), null);
  assert.equal(view.getByLabelText('Question text RU').getAttribute('aria-invalid'), null);
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'Saved'));
});

test('duplicates flush current edits, select copies and preserve the original question and round', async () => {
  const round = { id: 'round', quizId: 'quiz', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  let question = { ...source, textEn: 'Original' };
  let copies = 0, roundCopies = 0;
  let reply!: (response: Response) => void;
  let pending = false;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'PUT') {
      question = { ...question, ...JSON.parse(String(init.body)) };
      pending = true;
      return new Promise(done => { reply = done; });
    }
    if (path.endsWith('/one/duplicate')) { copies++; return Response.json({ ...question, id: 'copy', position: 1 }); }
    if (path.endsWith('/round/duplicate')) { roundCopies++; return Response.json({ ...round, id: 'round-copy', titleRu: 'Раунд (Копия)', titleEn: 'Round (Copy)', position: 1 }); }
    if (path.endsWith('/rounds')) return Response.json([round]);
    if (path.endsWith('/questions')) return Response.json(path.includes('/round-copy/') ? [{ ...question, id: 'round-question', roundId: 'round-copy' }] : [question]);
    if (path.endsWith('/options') || path.endsWith('/media')) return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const view = render(<EditorSaves><Rounds quizId="quiz" /></EditorSaves>);
  await waitFor(() => assert.ok(view.getByLabelText('Question text EN')));
  fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Saved before copy' } });
  fireEvent.click(view.getByRole('button', { name: 'Duplicate question' }));
  await waitFor(() => assert.equal(pending, true, 'Question PUT started'));
  assert.equal(copies, 0);
  await act(async () => reply(Response.json(question)));
  await waitFor(() => assert.equal(view.getByRole('button', { name: '2. Saved before copy' }).getAttribute('aria-current'), 'true'));
  assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Saved before copy');
  pending = false;
  fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Saved before round copy' } });
  fireEvent.click(view.getByRole('button', { name: 'Duplicate round' }));
  await waitFor(() => assert.equal(pending, true, 'Question PUT started'));
  assert.equal(roundCopies, 0);
  await act(async () => reply(Response.json(question)));
  await waitFor(() => assert.equal((view.getByLabelText('Round title EN') as HTMLInputElement).value, 'Round (Copy)'));
  assert.ok(view.getByRole('button', { name: 'Round / Раунд' }));
  assert.equal(copies, 1); assert.equal(roundCopies, 1);
  await waitFor(() => assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'Saved before round copy'));
});

test('upload attaches to the current question and retries attachment without uploading twice', async () => {
  const old = { id: 'old', name: 'old.png', kind: 'image' };
  const uploaded = { id: 'new', name: 'new.png', kind: 'image' };
  const question = { ...source, textEn: 'Question', media: [{ mediaId: 'old', playBeforeTimer: false }] };
  let uploads = 0, failed = true;
  const updates: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'POST') {
      assert.equal(path, '/api/quizzes/quiz/media');
      assert.ok(init.body instanceof FormData);
      assert.equal((init.body.get('file') as File).name, 'new.png');
      uploads++; return Response.json(uploaded, { status: 201 });
    }
    if (init?.method === 'PUT') {
      assert.equal(path, '/api/quizzes/quiz/rounds/round/questions/one');
      const update = JSON.parse(String(init.body)); updates.push(update);
      assert.deepEqual(update.media, [{ mediaId: 'old', playBeforeTimer: false }, { mediaId: 'new', playBeforeTimer: false }]);
      return failed ? Response.json({ error: 'Attachment unavailable.' }, { status: 500 }) : Response.json({ ...question, ...update });
    }
    if (path.endsWith('/questions')) return Response.json([question]);
    if (path.endsWith('/media')) return Response.json(uploads ? [old, uploaded] : [old]);
    if (path.endsWith('/options')) return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const view = render(<EditorSaves><Questions quizId="quiz" roundId="round" /></EditorSaves>);
  await waitFor(() => assert.ok(view.getByLabelText('Question media file')));
  fireEvent.change(view.getByLabelText('Question media file'), { target: { files: [new File(['image'], 'new.png', { type: 'image/png' })] } });
  assert.equal((view.getByRole('button', { name: 'Upload & attach' }) as HTMLButtonElement).disabled, false);
  fireEvent.click(view.getByRole('button', { name: 'Upload & attach' }));
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Attachment unavailable.')));
  assert.ok(!view.queryByAltText('new.png'));
  failed = false;
  fireEvent.click(view.getByRole('button', { name: 'Upload & attach' }));
  await waitFor(() => assert.ok(view.getByAltText('new.png')));
  assert.equal(uploads, 1); assert.equal(updates.length, 2);
  assert.ok(view.getByAltText('old.png'));
});


test('round translation hints clear as soon as both descriptions are complete', async () => {
  const round = { id: 'round', quizId: 'quiz', titleRu: 'Раунд', titleEn: '', descriptionRu: 'Описание', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  globalThis.fetch = async (input, init) => String(input).endsWith('/rounds') ? Response.json([round])
    : init?.method === 'PUT' ? Response.json({ ...round, ...JSON.parse(String(init.body)) }) : Response.json([]);
  const view = render(<Rounds quizId="quiz" />);
  await waitFor(() => assert.ok(view.getByLabelText('Round title EN')));
  assert.equal(view.getByLabelText('Round title EN').getAttribute('aria-invalid'), 'true');
  assert.equal(view.getByLabelText('Round description EN').getAttribute('aria-invalid'), 'true');
  fireEvent.change(view.getByLabelText('Round title EN'), { target: { value: 'Round' } });
  fireEvent.change(view.getByLabelText('Round description EN'), { target: { value: 'Description' } });
  assert.equal(view.getByLabelText('Round title EN').getAttribute('aria-invalid'), null);
  assert.equal(view.getByLabelText('Round description EN').getAttribute('aria-invalid'), null);
  await waitFor(() => assert.equal(view.container.querySelector('.round-status')?.textContent, 'Saved'));
});

test('multiple-choice hints require two correct answers and cover optional explanations and numeric settings', async () => {
  const question = { ...source, type: 'multiple_choice', textEn: 'Question', points: 0, answerTimeSeconds: 0, explanationRu: 'Почему', explanationEn: '' };
  const options = answers.map((answer, index) => ({ ...answer, textEn: 'Answer', isCorrect: index === 0 }));
  globalThis.fetch = async (input, init) => String(input).endsWith('/questions') ? Response.json([question])
    : String(input).endsWith('/options') ? Response.json(options)
    : String(input).endsWith('/media') ? Response.json([]) : Response.json(JSON.parse(String(init?.body ?? '{}')));
  const view = render(<Questions quizId="quiz" roundId="round" />);
  await waitFor(() => assert.ok(view.getByLabelText('Correct answer, option 2')));
  assert.ok(view.getByText('Choose at least two correct answers.'));
  fireEvent.click(view.getByLabelText('Correct answer, option 2'));
  assert.ok(!view.queryByText('Choose at least two correct answers.'));
  for (const [label, value] of [['Points', '2'], ['Custom answer time (seconds)', '45'], ['Explanation EN (after Reveal)', 'Why']]) {
    const input = view.getByLabelText(label);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    fireEvent.change(input, { target: { value } });
    assert.equal(input.getAttribute('aria-invalid'), null);
  }
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'Saved'));
});

test('matching text hints are specific to each side and translation', async () => {
  const question = { ...source, type: 'matching', textEn: 'Question' };
  const pairs = [{ id: 'pair', questionId: 'one', left: { kind: 'text', textRu: 'Кошка', textEn: '' }, right: { kind: 'text', textRu: 'Животное', textEn: 'Animal' }, position: 0 }];
  globalThis.fetch = async (input, init) => String(input).endsWith('/questions') ? Response.json([question])
    : String(input).endsWith('/pairs') ? Response.json(pairs)
    : String(input).endsWith('/media') ? Response.json([]) : Response.json(JSON.parse(String(init?.body ?? '{}')));
  const view = render(<Questions quizId="quiz" roundId="round" />);
  await waitFor(() => assert.ok(view.getByLabelText('Pair 1 left EN')));
  const input = view.getByLabelText('Pair 1 left EN');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(view.getByLabelText('Pair 1 right EN').getAttribute('aria-invalid'), null);
  fireEvent.change(input, { target: { value: 'Cat' } });
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.ok(view.getByText('Add at least two matching pairs.'));
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'Saved'));
});
