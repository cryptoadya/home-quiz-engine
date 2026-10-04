import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { QuestionContent } from './GameContent';
import { previewContent } from './QuizPreview';
import type { CurrentQuestion } from './lobby';
import type { Question, Option, Pair } from './Questions';

afterEach(cleanup);

test('Reveal warns about overflowing explanation or answer content even when the question fits', () => {
  const originalObserver = globalThis.ResizeObserver;
  let measure = () => {};
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    const question: CurrentQuestion = { state: 'ANSWER_REVEAL', roundNumber: 1, questionNumber: 1, questionCount: 1,
      textRu: 'Короткий вопрос', textEn: 'Short question', explanationRu: 'Длинное объяснение', explanationEn: 'Long explanation',
      options: [{ textRu: 'Ответ', textEn: 'Answer', isCorrect: true }] };
    const view = render(createElement(QuestionContent, { question }));
    const root = view.container.querySelector('.question-presentation')!;
    const copy = view.container.querySelector('.question-copy')!;
    let contentHeight = 900;
    Object.defineProperties(root, { clientHeight: { get: () => 700 }, scrollHeight: { get: () => contentHeight } });
    Object.defineProperties(copy, { clientHeight: { get: () => 100 }, scrollHeight: { get: () => 100 } });
    act(() => measure());
    assert.equal(root.getAttribute('data-text-overflow'), 'true');
    contentHeight = 700;
    view.rerender(createElement(QuestionContent, { question: { ...question, explanationRu: 'Кратко', explanationEn: 'Brief' } }));
    assert.equal(root.getAttribute('data-text-overflow'), null, 'Live explanation edits recompute the warning');
  } finally { globalThis.ResizeObserver = originalObserver; }
});

test('Screen Reveal puts the answer and explanation before the repeated question and media in reading order', () => {
  const question: CurrentQuestion = {
    state: 'ANSWER_REVEAL', roundNumber: 1, questionNumber: 1, questionCount: 1,
    textRu: 'Какого цвета тыква?', textEn: 'What colour is a pumpkin?',
    explanationRu: 'Обычно оранжевая.', explanationEn: 'Usually orange.',
    options: [{ textRu: 'Оранжевый', textEn: 'Orange', isCorrect: true }, { textRu: 'Синий', textEn: 'Blue', isCorrect: false }],
    media: [{ mediaId: 'photo', name: 'Photo', mediaUrl: '/photo' }],
  };
  const view = render(createElement(QuestionContent, { question }));
  const children = [...view.container.querySelector('.question-presentation')!.children];
  assert.ok(children.indexOf(view.container.querySelector('.correct-answers')!) < children.indexOf(view.container.querySelector('.explanation')!));
  assert.ok(children.indexOf(view.container.querySelector('.explanation')!) < children.indexOf(view.container.querySelector('.question-copy')!));
  assert.ok(children.indexOf(view.container.querySelector('.question-copy')!) < children.indexOf(view.container.querySelector('.question-media')!));
  assert.equal(view.queryByText('Blue'), null);
});

test('Matching Reveal uses the same primary answer area and keeps the authored pairs', () => {
  const question: CurrentQuestion = {
    state: 'ANSWER_REVEAL', type: 'matching', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Соедините', textEn: 'Match',
    leftItems: [{ id: 'left', kind: 'text', textRu: 'Кот', textEn: 'Cat' }],
    rightItems: [{ id: 'right', kind: 'text', textRu: 'Животное', textEn: 'Animal' }],
    correctMapping: [{ leftId: 'left', rightId: 'right' }],
  };
  const view = render(createElement(QuestionContent, { question }));
  const summary = view.container.querySelector('.correct-answers');
  assert.ok(summary);
  assert.ok(summary.querySelector('.correct-pairs'));
  assert.ok(summary.textContent?.includes('Cat'));
  assert.ok(summary.textContent?.includes('Animal'));
  assert.equal(view.queryByRole('button'), null);
});
test('playing video gets the presentation area while other media stay mounted for playback continuity', () => {
  const oldPause = window.HTMLMediaElement.prototype.pause;
  window.HTMLMediaElement.prototype.pause = () => {};
  try {
    const question: CurrentQuestion = { state: 'ANSWERING', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: '', textEn: '', media: [
      { mediaId: 'photo', name: 'Photo', mediaUrl: '/photo' },
      { mediaId: 'video', name: 'Video', kind: 'video', mediaUrl: '/video', playback: { playing: true, positionSeconds: 0, serverNow: 0, revision: 1 } },
    ] };
    const view = render(createElement(QuestionContent, { question }));
    assert.equal(view.container.querySelector('.question-video')?.getAttribute('data-featured'), 'true');
    assert.ok(view.getByAltText('Изображение / Image'));
    const video = view.container.querySelector('video');
    view.rerender(createElement(QuestionContent, { question: { ...question, answers: { answered: 1, expected: 2 } } }));
    assert.equal(view.container.querySelector('video'), video);
  } finally { cleanup(); window.HTMLMediaElement.prototype.pause = oldPause; }
});
const base = { roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question' };
const cases = [
  { type: 'single_choice', correct: ['Верно / Right'], wrong: ['Неверно / Wrong'], heading: 'Правильный ответ / Correct answer' },
  { type: 'multiple_choice', correct: ['Первый / First', 'Второй / Second'], wrong: ['Неверно / Wrong'], heading: 'Правильные ответы / Correct answers' },
  { type: 'yes_no', correct: ['Нет / No'], wrong: ['Да / Yes'], heading: 'Правильный ответ / Correct answer' },
] as const;
for (const { type, correct, wrong, heading } of cases) {
  const options = [...wrong.map(text => ({ text, isCorrect: false })), ...correct.map(text => ({ text, isCorrect: true }))]
    .map(({ text, isCorrect }, index) => { const [textRu, textEn] = text.split(' / '); return { id: String(index), questionId: 'q', position: index, createdAt: '', updatedAt: '', textRu, textEn, isCorrect }; });
  for (const legacyFlag of [false, true]) test(`${type} Screen hides every option during answering with legacy flag ${legacyFlag}`, () => {
    const question = { ...base, type, state: 'ANSWERING' as const, options, showOptionsOnScreen: legacyFlag };
    const view = render(createElement(QuestionContent, { question }));
    assert.ok(view.getByText('Question'));
    for (const option of options) assert.equal(Boolean(view.queryByText(option.textEn)), false);
    assert.equal(Boolean(view.container.querySelector('.game-options')), false);
  });
  test(`${type} Screen Reveal renders only the bilingual correct answer set without answer-selection UI`, () => {
    const question: CurrentQuestion = { ...base, type, state: 'ANSWER_REVEAL', options };
    const view = render(createElement(QuestionContent, { question }));
    assert.ok(view.getByRole('heading', { name: heading }));
    for (const text of correct) for (const language of text.split(' / ')) assert.ok(view.getByText(language));
    for (const text of wrong) for (const language of text.split(' / ')) assert.equal(Boolean(view.queryByText(language)), false);
    assert.equal(view.container.querySelectorAll('.correct-option').length, correct.length);
    assert.equal(Boolean(view.container.querySelector('.option-letter, .incorrect-option, .game-options')), false);
    assert.equal(view.queryByRole('checkbox'), null);
  });
  test(`${type} Screen Preview projects no options while answering and only correct options on Reveal`, () => {
    const question: Question = { ...base, id: 'q', roundId: 'r', type, points: 1, answerTimeSeconds: null, position: 0, createdAt: '', updatedAt: '' };
    const props = { quizId: 'quiz', question, options: options as Option[], pairs: [] as Pair[], media: [], ...base };
    assert.equal(previewContent(props, 'Screen', false).question?.options, undefined);
    assert.deepEqual(previewContent(props, 'Screen', true).question?.options?.map(o => o.textEn), correct.map(text => text.split(' / ')[1]));
    assert.equal(previewContent(props, 'Host', false).question?.options?.length, options.length);
    assert.equal(previewContent(props, 'EN Player', false).player?.options.length, options.length);
  });
}

test('Matching Screen Preview projects candidates only to Host/Player and correct pairs only on Reveal', () => {
  const question: Question = { ...base, id: 'q', roundId: 'r', type: 'matching', points: 1, answerTimeSeconds: null, position: 0, createdAt: '', updatedAt: '' };
  const pairs: Pair[] = [
    { id: 'a', questionId: 'q', position: 0, left: { kind: 'text', textRu: 'Кот', textEn: 'Cat' }, right: { kind: 'text', textRu: 'Животное', textEn: 'Animal' } },
    { id: 'b', questionId: 'q', position: 1, left: { kind: 'image', mediaId: 'photo' }, right: { kind: 'text', textRu: 'Фото', textEn: 'Photo' } },
  ];
  const props = { quizId: 'quiz', question, pairs, options: [], media: [], ...base };
  const answering = previewContent(props, 'Screen', false).question!;
  assert.equal(answering.leftItems, undefined); assert.equal(answering.rightItems, undefined); assert.equal(answering.correctMapping, undefined);
  const reveal = previewContent(props, 'Screen', true).question!;
  assert.equal(reveal.correctMapping?.length, 2);
  const view = render(createElement(QuestionContent, { question: reveal }));
  assert.equal(Boolean(view.container.querySelector('.matching-columns')), false);
  assert.equal(view.container.querySelectorAll('.correct-pairs li').length, 2);
  assert.ok(view.getByText('Cat', { exact: false })); assert.ok(view.getByText('Animal', { exact: false }));
  assert.equal(view.getByRole('img').getAttribute('src'), '/api/quizzes/quiz/media/photo/content');
  assert.equal(previewContent(props, 'Host', false).question?.leftItems?.length, 2);
  assert.equal(previewContent(props, 'EN Player', false).player?.leftItems?.length, 2);
});
