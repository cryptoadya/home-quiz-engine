import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Questions } from './Questions';
afterEach(cleanup);

test('Matching editor creates, autosaves bilingual sides, reorders, deletes, reloads and switches type', async () => {
  const original = globalThis.fetch;
  const question = { id: 'q', roundId: 'round', type: 'matching', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 };
  const blank = () => ({ kind: 'text', textRu: '', textEn: '' });
  const makePair = (id: string) => ({ id, questionId: 'q', left: blank(), right: blank(), position: 0 });
  let pairs = [makePair('a'), makePair('b')];
  let questions: typeof question[] = [];
  let next = 0;
  let saved = false;
  globalThis.fetch = async (url, init) => {
    const path = String(url); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith('/questions')) {
      if (method === 'POST') { assert.deepEqual(body, { type: 'matching' }); questions = [question]; return Response.json(question); }
      return Response.json(questions);
    }
    if (path.endsWith('/pairs/order')) {
      pairs = body.ids.map((id: string, position: number) => ({ ...pairs.find(pair => pair.id === id)!, position }));
      return Response.json(pairs);
    }
    if (path.endsWith('/pairs')) {
      if (method === 'POST') { const pair = makePair(`new-${next++}`); pairs.push(pair); return Response.json(pair); }
      return Response.json(pairs);
    }
    if (path.includes('/pairs/')) {
      const id = path.split('/').pop()!;
      if (method === 'DELETE') { pairs = pairs.filter(pair => pair.id !== id); return new Response(null, { status: 204 }); }
      assert.equal(method, 'PUT'); saved = true;
      const pair = pairs.find(pair => pair.id === id)!; Object.assign(pair, body); return Response.json(pair);
    }
    if (path.endsWith('/options')) return Response.json([]);
    if (method === 'PUT') { Object.assign(question, body); pairs = question.type === 'matching' ? [makePair('c'), makePair('d')] : []; return Response.json(question); }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  try {
    const view = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(view.getByText('No questions yet.')));
    fireEvent.click(view.getByRole('button', { name: 'Add Matching question' }));
    await waitFor(() => assert.ok(view.getByLabelText('Pair 2 right EN')));
    assert.ok(!view.queryByText('Answer options'));
    assert.equal(view.queryAllByRole('radio').length, 0);
    fireEvent.change(view.getByLabelText('Pair 1 left RU'), { target: { value: 'Кот' } });
    fireEvent.change(view.getByLabelText('Pair 1 left EN'), { target: { value: 'Cat' } });
    fireEvent.change(view.getByLabelText('Pair 1 right RU'), { target: { value: 'Животное' } });
    fireEvent.change(view.getByLabelText('Pair 1 right EN'), { target: { value: 'Animal' } });
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Move pair 1 down' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(view.getByRole('button', { name: 'Move pair 1 down' }));
    await waitFor(() => assert.equal((view.getByLabelText('Pair 2 left EN') as HTMLInputElement).value, 'Cat'));
    assert.equal(saved, true);
    assert.deepEqual(pairs[1].left, { kind: 'text', textRu: 'Кот', textEn: 'Cat' });
    assert.deepEqual(pairs[1].right, { kind: 'text', textRu: 'Животное', textEn: 'Animal' });
    // Updated pair fields can render before the preceding action clears busy.
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Add pair' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(view.getByRole('button', { name: 'Add pair' }));
    await waitFor(() => assert.ok(view.getByLabelText('Pair 3 left RU')));
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Delete pair 1' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(view.getByRole('button', { name: 'Delete pair 1' }));
    await waitFor(() => assert.ok(!view.queryByLabelText('Pair 3 left RU')));
    view.unmount();
    const reload = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.equal((reload.getByLabelText('Pair 1 left EN') as HTMLInputElement).value, 'Cat'));
    fireEvent.change(reload.getByLabelText('Question type'), { target: { value: 'single_choice' } });
    await waitFor(() => assert.ok(reload.getByRole('button', { name: 'Add option' })));
    assert.ok(!reload.queryByLabelText('Pair 1 left EN'));
    await waitFor(() => assert.equal((reload.getByLabelText('Question type') as HTMLSelectElement).disabled, false));
    fireEvent.change(reload.getByLabelText('Question type'), { target: { value: 'matching' } });
    await waitFor(() => assert.equal((reload.getByLabelText('Pair 1 left EN') as HTMLInputElement).value, ''));
    assert.equal(pairs.length, 2); assert.ok(!reload.queryByRole('button', { name: 'Add option' }));
  } finally { globalThis.fetch = original; }
});
