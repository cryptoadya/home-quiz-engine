import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Questions } from './Questions';
import { QuestionContent } from './GameContent';
import { PlayerAnswer } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import type { PlayerQuestion } from './lobby';
afterEach(cleanup);

test('question attachments preserve ordered IDs, reorder/remove, and Matching image/text authoring autosaves and reloads', async () => {
  const original = globalThis.fetch;
  const media = [{ id: 'a', kind: 'image', name: 'photo.png' }, { id: 'b', kind: 'image', name: 'animation.gif' }, { id: 'c', kind: 'audio', name: 'sound.mp3' }];
  const question = { id: 'q', type: 'matching', textRu: '', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, media: [{ mediaId: 'b', playBeforeTimer: false }] };
  const pair = { id: 'p', questionId: 'q', left: { kind: 'text', textRu: 'Кот', textEn: 'Cat' }, right: { kind: 'text', textRu: 'Ответ', textEn: 'Answer' } };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/media')) return Response.json(media);
    if (path.endsWith('/questions')) return Response.json([question]);
    if (path.endsWith('/pairs')) return Response.json([pair]);
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/pairs/p')) { Object.assign(pair, body); return Response.json(pair); }
    Object.assign(question, body); return Response.json(question);
  };
  try {
    const view = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(view.getByLabelText('Pair 1 left EN')));
    await waitFor(() => assert.ok(view.getByText('photo.png (image)')));
    fireEvent.change(view.getByLabelText('Attach question media'), { target: { value: 'a' } });
    fireEvent.click(view.getByLabelText('Move media 2 up'));
    await waitFor(() => assert.deepEqual(question.media.map(ref => ref.mediaId), ['a', 'b']));
    fireEvent.click(view.getByLabelText('Remove media 2'));
    fireEvent.change(view.getByLabelText('Pair 1 left kind'), { target: { value: 'image' } });
    await waitFor(() => assert.deepEqual(pair.left, { kind: 'image', mediaId: 'a' }));
    assert.equal(view.queryByLabelText('Pair 1 left EN'), null);
    assert.equal(view.queryByText('Play before answer timer starts'), null);
    await waitFor(() => assert.deepEqual(question.media, [{ mediaId: 'a', playBeforeTimer: false }]));
    fireEvent.change(view.getByLabelText('Attach question media'), { target: { value: 'c' } });
    fireEvent.click(view.getByLabelText('Play before answer timer starts'));
    await waitFor(() => assert.deepEqual(question.media, [{ mediaId: 'a', playBeforeTimer: false }, { mediaId: 'c', playBeforeTimer: true }]));
    fireEvent.change(view.getByLabelText('Question text EN'), { target: { value: 'Media question' } });
    await waitFor(() => assert.equal(question.textEn, 'Media question'));
    assert.equal(question.media[1].playBeforeTimer, true);
    view.unmount();
    const reload = render(createElement(Questions, { quizId: 'quiz', roundId: 'round' }));
    await waitFor(() => assert.ok(reload.getByLabelText('Pair 1 left image')));
    assert.equal((reload.getByLabelText('Pair 1 left kind') as HTMLSelectElement).value, 'image');
    fireEvent.change(reload.getByLabelText('Pair 1 left kind'), { target: { value: 'text' } });
    await waitFor(() => assert.deepEqual(pair.left, { kind: 'text', textRu: '', textEn: '' }));
  } finally { globalThis.fetch = original; }
});

test('Screen/Host images, GIF URLs and mixed Matching render; Player only renders interactive images and recovers accepted mapping', () => {
  const image = { id: 'l', kind: 'image' as const, mediaId: 'photo', mediaUrl: '/api/rooms/room/media/photo/content' };
  const right = { id: 'r', kind: 'text' as const, text: 'Cat' };
  const mapping = [{ leftId: 'l', rightId: 'r' }];
  const base = { state: 'ANSWERING' as const, roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question', showOptionsOnScreen: true, media: [{ mediaId: 'gif', name: 'animation.gif', mediaUrl: '/api/rooms/room/media/gif/content' }], leftItems: [image], rightItems: [{ ...right, textRu: 'Кот', textEn: 'Cat' }] };
  for (const host of [false, true]) {
    const view = render(createElement(QuestionContent, { host, question: { ...base, ...(host ? { correctMapping: mapping } : {}) } }));
    assert.equal(view.getAllByRole('img').length, 2);
    const gif = view.getByAltText('animation.gif');
    assert.equal(gif.getAttribute('src'), base.media[0].mediaUrl);
    fireEvent.error(gif);
    assert.ok(view.getByText('Изображение недоступно / Image unavailable'));
    view.unmount();
  }
  const question: PlayerQuestion = { state: 'ANSWERING', type: 'matching', questionId: 'q', text: 'Match', options: [], leftItems: [image], rightItems: [right], submission: { submitted: true, mapping }, timer: { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false } };
  const view = render(createElement(PlayerAnswer, { question, roomId: 'room', token: 'token', language: 'en' }));
  assert.equal(view.queryByAltText('animation.gif'), null);
  assert.ok(view.getAllByRole('img').every(img => img.getAttribute('src') === image.mediaUrl));
  assert.ok(view.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled));
  view.unmount();
  const reveal = render(createElement(PlayerRevealContent, { language: 'en', question: { ...question, state: 'ANSWER_REVEAL', correctMapping: mapping, result: { outcome: 'correct', points: 1 } } }));
  assert.equal(reveal.getByRole('img').getAttribute('src'), image.mediaUrl);
});
