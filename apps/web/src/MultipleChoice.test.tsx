import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { PlayerAnswer } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import { Questions } from './Questions';
import type { PlayerQuestion } from './lobby';
afterEach(cleanup);

test('Multiple Choice drafts toggle, Submit requires one, retries and reconnect restore the full set', async () => {
  const original = globalThis.fetch;
  const question: PlayerQuestion = { state: 'ANSWERING', type: 'multiple_choice', requiredCorrectCount: 2, questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }, { id: 'b', text: 'Pear' }, { id: 'c', text: 'Plum' }], submission: { submitted: false }, timer: { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false } };
  const posts: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length === 1) throw new Error('ack lost');
    return Response.json({ submitted: true, optionIds: ['a', 'b'] });
  };
  try {
    const props = { question, roomId: 'room', token: 'secret', language: 'en' as const };
    const view = render(createElement(PlayerAnswer, props));
    assert.ok(view.getByText('Required correct options: 2'));
    assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
    fireEvent.click(view.getByLabelText('Apple'));
    assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, false);
    fireEvent.click(view.getByLabelText('Pear')); fireEvent.click(view.getByLabelText('Plum')); fireEvent.click(view.getByLabelText('Plum'));
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));
    await waitFor(() => assert.ok(view.getByRole('alert')));
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));
    await waitFor(() => assert.ok(view.getByText('Answer submitted')));
    assert.deepEqual(posts, Array(2).fill({ token: 'secret', questionId: 'q', optionIds: ['a', 'b'] }));
    view.unmount();
    const restored = render(createElement(PlayerAnswer, { ...props, question: { ...question, submission: { submitted: true, optionIds: ['b', 'a'] } } }));
    for (const label of ['Apple', 'Pear']) assert.equal((restored.getByLabelText(label) as HTMLInputElement).checked, true);
    assert.equal((restored.getByLabelText('Plum') as HTMLInputElement).checked, false);
    assert.ok(restored.getAllByRole('checkbox').every(input => (input as HTMLInputElement).disabled));
    restored.unmount();
    const reveal = render(createElement(PlayerRevealContent, { language: 'en', question: { ...question, state: 'ANSWER_REVEAL', submission: { submitted: true, optionIds: ['a', 'b'] }, correctOptionIds: ['a', 'b'], result: { outcome: 'correct', points: 5 } } }));
    assert.ok(reveal.getByText('Correct! +5')); assert.ok(reveal.getByText('Correct answer: Apple, Pear'));
  } finally { globalThis.fetch = original; }
});

test('Multiple Choice editor creates, autosaves independent correctness and reloads', async () => {
  const original = globalThis.fetch;
  const q = { id: 'q', roundId: 'round', type: 'multiple_choice', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, showCorrectCount: true, position: 0 };
  let questions: typeof q[] = [];
  const options = ['a', 'b', 'c'].map((id, position) => ({ id, questionId: 'q', textRu: id, textEn: id, isCorrect: false, position }));
  globalThis.fetch = async (url, init) => {
    const path = String(url), method = init?.method ?? 'GET';
    if (path.endsWith('/questions')) {
      if (method === 'POST') { assert.deepEqual(JSON.parse(String(init?.body)), { type: 'multiple_choice' }); questions = [q]; return Response.json(q); }
      return Response.json(questions);
    }
    if (path.endsWith('/options')) return Response.json(options);
    if (method === 'PUT' && path.endsWith('/q')) { Object.assign(q, JSON.parse(String(init?.body))); return Response.json(q); }
    const option = options.find(o => path.endsWith(`/${o.id}`));
    if (method === 'PUT' && option) { Object.assign(option, JSON.parse(String(init?.body))); return Response.json(option); }
    throw new Error(`Unexpected ${path}`);
  };
  try {
    const view = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(view.getByText('No questions yet.')));
    fireEvent.click(view.getByRole('button', { name: 'Add Multiple Choice question' }));
    await waitFor(() => assert.ok(view.getByLabelText('Option 3 EN')));
    fireEvent.click(view.getByLabelText('Show correct-option count to Player'));
    await waitFor(() => assert.equal(q.showCorrectCount, false));
    for (const index of [1, 2]) fireEvent.click(view.getByLabelText(`Correct answer, option ${index}`));
    await waitFor(() => assert.equal(options.filter(o => o.isCorrect).length, 2));
    assert.ok(view.getByRole('button', { name: 'Add option' })); assert.equal(view.queryAllByRole('radio').length, 0);
    view.unmount();
    const reloaded = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.equal((reloaded.getByLabelText('Correct answer, option 2') as HTMLInputElement).checked, true));
    assert.equal((reloaded.getByLabelText('Correct answer, option 1') as HTMLInputElement).checked, true);
    assert.equal((reloaded.getByLabelText('Show correct-option count to Player') as HTMLInputElement).checked, false);
  } finally { globalThis.fetch = original; }
});

for (const language of ['ru', 'en'] as const) test(`Multiple Choice without count hint omits hint and still accepts drafts (${language})`, () => {
  const question: PlayerQuestion = { state: 'ANSWERING', type: 'multiple_choice', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }, { id: 'b', text: 'Pear' }], submission: { submitted: false }, timer: { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false } };
  const view = render(createElement(PlayerAnswer, { question, language, roomId: 'room', token: 'token' }));
  assert.equal(view.queryByText(/Required correct options|Количество верных вариантов/), null);
  fireEvent.click(view.getByLabelText('Apple'));
  assert.equal((view.getByRole('button', { name: language === 'en' ? 'Submit' : 'Отправить' }) as HTMLButtonElement).disabled, false);
});
