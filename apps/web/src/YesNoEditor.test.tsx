import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Questions } from './Questions';
afterEach(cleanup);

test('Yes / No editor has fixed bilingual rows, one correct answer and safe type switching', async () => {
  const original = globalThis.fetch;
  const fields = { id: 'yes', roundId: 'round', type: 'yes_no', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 };
  const options = [
    { id: 'yes-option', questionId: 'yes', textRu: 'Да', textEn: 'Yes', isCorrect: true, position: 0 },
    { id: 'no-option', questionId: 'yes', textRu: 'Нет', textEn: 'No', isCorrect: false, position: 1 },
  ];
  let questions: typeof fields[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/media')) return Response.json([]);
    const method = init?.method || 'GET';
    if (path.endsWith('/questions')) {
      if (method === 'POST') { assert.deepEqual(JSON.parse(String(init?.body)), { type: 'yes_no' }); questions = [fields]; return Response.json(fields); }
      return Response.json(questions);
    }
    if (path.endsWith('/correct')) {
      options.forEach(o => { o.isCorrect = path.includes(o.id); }); return Response.json(options);
    }
    if (path.endsWith('/options')) return Response.json(options);
    if (method === 'PUT') { Object.assign(fields, JSON.parse(String(init?.body))); return Response.json(fields); }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  try {
    const view = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(view.getByText('No questions yet.')));
    fireEvent.change(view.getByLabelText('New question type'), { target: { value: 'yes_no' } });
    fireEvent.click(view.getByRole('button', { name: 'Add question' }));
    await waitFor(() => assert.ok(view.getByDisplayValue('Yes')));
    assert.equal(view.getAllByRole('radio').length, 2);
    assert.ok(!view.queryByRole('button', { name: 'Add option' }));
    assert.ok(!view.queryByRole('button', { name: 'Delete option 1' }));
    assert.ok(!view.queryByLabelText('Option 3 EN'));
    fireEvent.click(view.getByLabelText('Correct answer, option 2'));
    await waitFor(() => assert.equal((view.getByLabelText('Correct answer, option 2') as HTMLInputElement).checked, true));
    assert.equal((view.getByLabelText('Correct answer, option 1') as HTMLInputElement).checked, false);
    fireEvent.change(view.getByLabelText('Question type'), { target: { value: 'single_choice' } });
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Add option' })));
    assert.ok(view.getByDisplayValue('No'));
    await waitFor(() => assert.equal((view.getByLabelText('Question type') as HTMLSelectElement).disabled, false));
    fireEvent.change(view.getByLabelText('Question type'), { target: { value: 'yes_no' } });
    await waitFor(() => assert.ok(!view.queryByRole('button', { name: 'Add option' })));
    view.unmount();
    const reloaded = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(reloaded.getByDisplayValue('Yes')));
    assert.equal((reloaded.getByLabelText('Question type') as HTMLSelectElement).value, 'yes_no');
    assert.equal((reloaded.getByLabelText('Correct answer, option 2') as HTMLInputElement).checked, true);
  } finally { globalThis.fetch = original; }
});
