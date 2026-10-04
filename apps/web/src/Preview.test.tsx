import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QuizEditor } from './Admin';
import { lobbyTransport } from './lobby';

const originalFetch = globalThis.fetch;
const originalConnect = lobbyTransport.connect;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; lobbyTransport.connect = originalConnect; });

const quiz = { id: 'quiz', title: 'Preview quiz', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false, createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-28T12:00:00Z' };
const round = { id: 'round', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', position: 0 };
const question = { id: 'question', roundId: 'round', type: 'single_choice', textRu: 'Вопрос RU', textEn: 'Question EN', points: 2, answerTimeSeconds: null, showOptionsOnScreen: true, position: 0, media: [] as { mediaId: string; playBeforeTimer: boolean }[], createdAt: quiz.createdAt, updatedAt: quiz.updatedAt };
const options = [
  { id: 'a', questionId: 'question', textRu: 'Верный RU', textEn: 'Right EN', isCorrect: true, position: 0 },
  { id: 'b', questionId: 'question', textRu: 'Неверный RU', textEn: 'Wrong EN', isCorrect: false, position: 1 },
];

function show(source = question, pairs: unknown[] = [], media: unknown[] = []) {
  const requests: { path: string; method: string }[] = [];
  const writes: unknown[] = [];
  lobbyTransport.connect = () => { throw new Error('Preview must not connect a socket'); };
  globalThis.fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? 'GET';
    requests.push({ path, method });
    if (method !== 'GET') {
      assert.equal(method, 'PUT', 'Only ordinary editor autosave may write');
      assert.ok(path.startsWith('/api/quizzes/quiz') && !path.includes('/rooms'));
      writes.push(JSON.parse(String(init?.body)));
      return Response.json(source);
    }
    if (path.endsWith('/validation')) return Response.json({ ready: true, problems: [] });
    if (path.endsWith('/rounds')) return Response.json([round]);
    if (path.endsWith('/questions')) return Response.json([source]);
    if (path.endsWith('/options')) return Response.json(options);
    if (path.endsWith('/pairs')) return Response.json(pairs);
    if (path.endsWith('/media')) return Response.json(media);
    assert.equal(path, '/api/quizzes/quiz');
    return Response.json(quiz);
  };
  const view = render(createElement(MemoryRouter, { initialEntries: ['/admin/quizzes/quiz'] },
    createElement(Routes, null, createElement(Route, { path: '/admin/quizzes/:quizId', element: createElement(QuizEditor) }))));
  return { view, requests, writes };
}

test('all four previews share current editor content, localization and themes without gameplay persistence', async () => {
  const { view, requests, writes } = show();
  await waitFor(() => assert.ok(view.getByLabelText('Option 2 EN')));
  fireEvent.click(view.getByRole('button', { name: 'Preview question' }));
  const panel = within(view.getByRole('region', { name: 'Question preview' }));
  assert.ok(panel.getByText('Вопрос RU'));
  assert.equal(panel.queryByText('Question EN'), null);
  assert.equal(panel.queryByText(/Верный ответ/), null);
  fireEvent.click(panel.getByLabelText('Верный RU'));
  fireEvent.click(panel.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => assert.ok(panel.getByText('Ответ принят')));
  for (const mode of ['EN Player', 'Screen', 'Host', 'RU Player']) {
    fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: mode } });
    assert.ok(panel.getByText(mode === 'EN Player' ? 'Question EN' : 'Вопрос RU'));
    if (mode === 'Screen' || mode === 'Host') assert.ok(panel.getByText('Question EN'));
    if (mode === 'Host') assert.ok(panel.getByText('Верный ответ'));
    if (mode === 'Screen') { assert.equal(panel.queryByText('Right EN'), null); assert.equal(panel.queryByText('Wrong EN'), null); }
  }
  assert.equal(requests.filter(request => request.method !== 'GET').length, 0);
  assert.equal(writes.length, 0);
  assert.ok(requests.every(request => !/rooms|sessions|players|history|answers/.test(request.path)));
  fireEvent.change(view.getByLabelText('Theme'), { target: { value: 'halloween' } });
  assert.equal(view.getByRole('region', { name: 'Question preview' }).querySelector('[data-theme]')?.getAttribute('data-theme'), 'halloween');
  fireEvent.change(view.getByLabelText('Question text RU'), { target: { value: 'Новый RU' } });
  assert.ok(panel.getByText('Новый RU'));
  fireEvent.change(view.getByLabelText('Option 1 RU'), { target: { value: 'Новое значение' } });
  assert.ok(panel.getByLabelText('Новое значение'));
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Live quiz title' } });
  fireEvent.change(view.getByLabelText('Default answer time (seconds)'), { target: { value: '45' } });
  assert.equal(panel.getByRole('timer').textContent, '45');
  fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'Screen' } });
  assert.ok(panel.getByText('Live quiz title'));
  fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'RU Player' } });
  assert.equal(writes.length, 0, 'Live rendering must not wait for autosave');
  fireEvent.change(panel.getByLabelText('Preview state'), { target: { value: 'reveal' } });
  assert.ok(panel.getByText('Верный ответ: Новое значение'));
  fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'EN Player' } });
  assert.ok(panel.getByText('Correct answer: Right EN'));
  assert.equal(panel.queryByText(/Верный ответ/), null);
  fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'Screen' } });
  assert.ok(panel.getByText('Правильный ответ / Correct answer'));
  assert.equal(panel.queryByText('Wrong EN'), null);
  assert.equal((view.getByLabelText('Correct answer, option 1') as HTMLInputElement).checked, true);
  fireEvent.click(panel.getByRole('button', { name: 'Close preview' }));
  assert.equal(view.queryByRole('region', { name: 'Question preview' }), null);
});

import { previewContent, QuizPreview, type PreviewMode } from './QuizPreview';
import type { Quiz } from './Admin';
import type { Question, Option, Pair } from './Questions';
const previewProps = {
  quizId: 'quiz', quiz: quiz as Quiz, question: question as Question, options: options as Option[], pairs: [] as Pair[], media: [],
  roundNumber: 1, questionNumber: 1, questionCount: 1, onClose: () => {},
};

test('Player answering props omit hidden correctness, mappings, scores, normal media and session identity', () => {
  const pairs = [{ id: 'secret-pair', questionId: 'question', position: 0,
    left: { kind: 'text', textRu: 'Кот', textEn: 'Cat' }, right: { kind: 'text', textRu: 'Животное', textEn: 'Animal' } }] as Pair[];
  for (const type of ['single_choice', 'yes_no', 'multiple_choice', 'matching'] as const) {
    for (const mode of ['RU Player', 'EN Player'] as const) {
      const props = { ...previewProps, question: { ...previewProps.question, type, showCorrectCount: false, media: [{ mediaId: 'secret-video', playBeforeTimer: true }] }, pairs };
      const answering = previewContent(props, mode, false).player!;
      assert.ok(!/isCorrect|correctOption|correctMapping|requiredCorrectCount|result|points|secret-pair|secret-video|timer|deadline|token|session|roomId/.test(JSON.stringify(answering)));
      assert.equal(answering.text, mode === 'RU Player' ? 'Вопрос RU' : 'Question EN');
      if (type === 'matching') assert.equal(answering.leftItems?.[0].kind === 'text' && answering.leftItems[0].text, mode === 'RU Player' ? 'Кот' : 'Cat');
      const reveal = previewContent(props, mode, true).playerReveal!;
      if (type === 'matching') assert.equal(reveal.correctMapping?.length, 1);
      else assert.deepEqual(reveal.correctOptionIds, ['a']);
    }
  }
  assert.equal(previewContent({ ...previewProps, question: { ...previewProps.question, type: 'multiple_choice', showCorrectCount: true } }, 'EN Player', false).player?.requiredCorrectCount, 1);
  assert.equal(previewContent(previewProps, 'Screen', false).question?.options, undefined);
  assert.equal(previewContent(previewProps, 'Host', false).question?.options?.[0].isCorrect, true);
});

test('Default, Halloween and unavailable themes render every mode/state without running timers', () => {
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (() => { throw new Error('Preview must not run a timer'); }) as typeof setInterval;
  try {
    for (const themeId of ['default', 'halloween', 'unavailable']) {
      const view = render(createElement(QuizPreview, { ...previewProps, quiz: { ...previewProps.quiz, themeId } }));
      for (const mode of ['RU Player', 'EN Player', 'Screen', 'Host'] as PreviewMode[]) {
        fireEvent.change(view.getByLabelText('Preview mode'), { target: { value: mode } });
        fireEvent.change(view.getByLabelText('Preview state'), { target: { value: 'answering' } });
        assert.equal(view.container.querySelector('[data-theme]')?.getAttribute('data-theme'), themeId === 'unavailable' ? 'default' : themeId);
        assert.equal(view.getByRole('timer').textContent, '30');
        if (mode !== 'Host') assert.equal(view.container.querySelector('.correct-option'), null);
        fireEvent.change(view.getByLabelText('Preview state'), { target: { value: 'reveal' } });
        assert.equal(view.queryByRole('timer'), null);
        assert.ok(view.container.querySelector('.correct-option'));
      }
      view.unmount();
    }
  } finally { globalThis.setInterval = originalInterval; }
});

test('Matching text/images and ordered question media use shared rendering and failure fallbacks', async () => {
  const prototype = window.HTMLMediaElement.prototype;
  const originalPause = prototype.pause;
  let pauses = 0;
  prototype.pause = () => { pauses++; };
  try {
    const pairs = [
      { id: 'p1', questionId: 'question', position: 0, left: { kind: 'text', textRu: 'Кот', textEn: 'Cat' }, right: { kind: 'image', mediaId: 'cat' } },
      { id: 'p2', questionId: 'question', position: 1, left: { kind: 'image', mediaId: 'dog' }, right: { kind: 'text', textRu: 'Собака', textEn: 'Dog' } },
    ];
    const media = [{ id: 'cat', kind: 'image', name: 'Cat image' }, { id: 'clip', kind: 'video', name: 'Clip' }, { id: 'sound', kind: 'audio', name: 'Sound' }];
    const source = { ...question, type: 'matching', media: media.map(item => ({ mediaId: item.id, playBeforeTimer: item.kind !== 'image' })) };
    const { view, requests, writes } = show(source as typeof question, pairs, media);
    await waitFor(() => assert.ok(view.getByLabelText('Pair 2 right EN')));
    fireEvent.click(view.getByRole('button', { name: 'Preview question' }));
    const root = view.getByRole('region', { name: 'Question preview' });
    const panel = within(root);
    assert.ok(panel.getByRole('button', { name: '1. Кот' }));
    assert.equal(panel.queryByRole('button', { name: '1. Cat' }), null);
    assert.equal(panel.queryByLabelText('Clip'), null);
    const images = panel.getAllByRole('img');
    assert.ok(images.some(image => image.getAttribute('src') === '/api/quizzes/quiz/media/cat/content'));
    fireEvent.error(images[0]);
    assert.ok(panel.getByText('Изображение недоступно / Image unavailable'));
    fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'EN Player' } });
    assert.ok(panel.getByRole('button', { name: '1. Cat' }));
    assert.equal(panel.queryByRole('button', { name: '1. Кот' }), null);
    fireEvent.change(panel.getByLabelText('Preview state'), { target: { value: 'reveal' } });
    assert.ok(panel.getByText('Correct pairs'));
    fireEvent.change(view.getByLabelText('Pair 1 left EN'), { target: { value: 'Edited cat' } });
    assert.ok(panel.getByText(/Edited cat/));
    fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'Screen' } });
    await waitFor(() => assert.equal((panel.getByLabelText('Видео / Video') as HTMLVideoElement).src, 'http://localhost/api/quizzes/quiz/media/clip/content'));
    assert.ok(panel.getByText('Верные пары / Correct pairs'));
    assert.equal((panel.getByLabelText('Видео / Video') as HTMLVideoElement).controls, true);
    assert.equal((panel.getByLabelText('Аудио / Audio') as HTMLAudioElement).controls, true);
    assert.deepEqual([...root.querySelectorAll('.question-media img, .question-media video, .question-media audio')].map(element => element.getAttribute('src')), ['/api/quizzes/quiz/media/cat/content', '/api/quizzes/quiz/media/clip/content', '/api/quizzes/quiz/media/sound/content']);
    fireEvent.play(panel.getByLabelText('Видео / Video'));
    assert.equal(pauses, 1, 'Local video pauses its audio peer');
    fireEvent.error(panel.getByLabelText('Видео / Video'));
    assert.ok(panel.getByText(/Playback failed/));
    fireEvent.change(panel.getByLabelText('Preview state'), { target: { value: 'answering' } });
    assert.equal(panel.queryByText('Верные пары / Correct pairs'), null);
    fireEvent.change(panel.getByLabelText('Preview mode'), { target: { value: 'Host' } });
    assert.ok(panel.getByText('Верные пары / Correct pairs'));
    assert.equal(panel.queryByLabelText('Clip'), null, 'Host does not mount media players');
    assert.equal((panel.getByRole('button', { name: 'Проиграть Clip' }) as HTMLButtonElement).disabled, true);
    assert.equal(writes.length, 0);
    assert.ok(requests.every(request => request.path.startsWith('/api/quizzes/quiz') && request.method === 'GET'));
  } finally { prototype.pause = originalPause; }
});
