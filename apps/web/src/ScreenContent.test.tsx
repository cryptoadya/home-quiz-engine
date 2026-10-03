import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { QuestionContent } from './GameContent';
import { previewContent } from './QuizPreview';
import type { CurrentQuestion } from './lobby';
import type { Question, Option, Pair } from './Questions';

afterEach(cleanup);
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
