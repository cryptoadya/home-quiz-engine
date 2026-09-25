import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

afterEach(cleanup);

test('selected round edits draft questions and options, saves, reorders, and confirms deletion', async () => {
  const quiz = { id: 'q1', title: 'Quiz', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
  const round = { id: 'r1', quizId: 'q1', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0 };
  type Q = { id: string; roundId: string; type: 'single_choice'; textRu: string; textEn: string; points: number; answerTimeSeconds: number | null; showOptionsOnScreen: boolean; position: number };
  type O = { id: string; questionId: string; textRu: string; textEn: string; isCorrect: boolean; position: number };
  const questions: Q[] = [{ id: 'a', roundId: 'r1', type: 'single_choice', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0 }];
  const options: O[] = [];
  let fail = false;
  let confirmed = false;
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method || 'GET';
    if (path === '/api/quizzes/q1') return Response.json(quiz);
    if (path.endsWith('/rounds')) return Response.json([round]);
    if (path.endsWith('/questions')) {
      if (method === 'POST') {
        const item: Q = { ...questions[0], id: 'b', position: questions.length };
        questions.push(item); return Response.json(item, { status: 201 });
      }
      return Response.json(questions);
    }
    if (path.endsWith('/questions/order')) {
      const ids = JSON.parse(String(init?.body)).ids as string[];
      questions.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      questions.forEach((item, index) => { item.position = index; });
      return Response.json(questions);
    }
    if (path.endsWith('/options')) {
      if (method === 'POST') {
        const item: O = { id: `o${options.length + 1}`, questionId: 'b', textRu: '', textEn: '', isCorrect: false, position: options.length };
        options.push(item); return Response.json(item, { status: 201 });
      }
      return Response.json(options);
    }
    if (path.endsWith('/options/order')) {
      const ids = JSON.parse(String(init?.body)).ids as string[];
      options.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      options.forEach((item, index) => { item.position = index; });
      return Response.json(options);
    }
    if (path.endsWith('/correct')) {
      const id = path.split('/').at(-2);
      options.forEach((item) => { item.isCorrect = item.id === id; });
      return Response.json(options);
    }
    const id = path.split('/').at(-1);
    const question = questions.find((item) => item.id === id);
    const option = options.find((item) => item.id === id);
    if (method === 'PUT' && fail) return Response.json({ error: 'Offline' }, { status: 500 });
    if (method === 'PUT' && question) { Object.assign(question, JSON.parse(String(init?.body))); return Response.json(question); }
    if (method === 'PUT' && option) { Object.assign(option, JSON.parse(String(init?.body))); return Response.json(option); }
    if (method === 'DELETE' && question) { questions.splice(questions.indexOf(question), 1); return new Response(null, { status: 204 }); }
    if (method === 'DELETE' && option) { options.splice(options.indexOf(option), 1); return new Response(null, { status: 204 }); }
    return Response.json({ error: 'Missing' }, { status: 404 });
  };
  const view = render(createElement(MemoryRouter, { initialEntries: ['/admin/quizzes/q1'] }, createElement(App)));
  await waitFor(() => assert.ok(view.getByText('Questions')));
  await waitFor(() => assert.ok(view.getByRole('button', { name: '1. Untitled question' })));
  fireEvent.click(view.getByRole('button', { name: 'Add Single Choice question' }));
  await waitFor(() => assert.equal(questions.length, 2));
  await waitFor(() => assert.ok(view.getByLabelText('Question text RU')));
  fireEvent.change(view.getByLabelText('Question text RU'), { target: { value: 'Вопрос' } });
  fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Question' } });
  fireEvent.change(view.getByLabelText('Points'), { target: { value: '3' } });
  fireEvent.change(view.getByLabelText('Answer time'), { target: { value: 'custom' } });
  fireEvent.change(view.getByLabelText('Custom answer time (seconds)'), { target: { value: '42' } });
  fireEvent.click(view.getByLabelText('Show answer options on Screen'));
  await waitFor(() => assert.equal(questions[1].answerTimeSeconds, 42), { timeout: 2000 });
  assert.deepEqual([questions[1].textRu, questions[1].textEn, questions[1].points, questions[1].showOptionsOnScreen], ['Вопрос', 'Question', 3, true]);
  fireEvent.click(view.getByRole('button', { name: 'Add option' }));
  await waitFor(() => assert.equal(options.length, 1));
  fireEvent.change(view.getByLabelText('Option 1 RU'), { target: { value: 'Да' } });
  fireEvent.change(view.getByLabelText('Option 1 EN'), { target: { value: 'Yes' } });
  await waitFor(() => assert.equal(options[0].textEn, 'Yes'), { timeout: 2000 });
  fireEvent.click(view.getByRole('button', { name: 'Add option' }));
  await waitFor(() => assert.equal(options.length, 2));
  fireEvent.click(view.getByLabelText('Correct answer, option 2'));
  await waitFor(() => assert.equal(options[1].isCorrect, true));
  fireEvent.click(view.getByRole('button', { name: 'Move option 2 up' }));
  await waitFor(() => assert.equal(options[0].id, 'o2'));
  fireEvent.click(view.getByRole('button', { name: 'Delete option 1' }));
  await waitFor(() => assert.equal(options.length, 1));
  assert.equal(options[0].isCorrect, false);
  fireEvent.change(view.getByLabelText('Answer time'), { target: { value: 'default' } });
  await waitFor(() => assert.equal(questions[1].answerTimeSeconds, null), { timeout: 2000 });
  fireEvent.click(view.getByRole('button', { name: 'Move question 2 up' }));
  await waitFor(() => assert.equal(questions[0].id, 'b'));
  fireEvent.click(view.getByRole('button', { name: 'Delete question' }));
  assert.equal(questions.length, 2);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Delete question' }));
  await waitFor(() => assert.equal(questions.length, 1));
  fail = true;
  fireEvent.change(view.getByLabelText('Question text RU'), { target: { value: 'Incomplete draft' } });
  await waitFor(() => assert.equal(view.getByText('Save failed', { selector: '.question-status' }).textContent, 'Save failed'), { timeout: 2000 });
  assert.ok(view.getByRole('alert').textContent?.includes('Offline'));
});
