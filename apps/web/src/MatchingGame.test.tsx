import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { PlayerAnswer } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import { QuestionContent } from './GameContent';
import type { PlayerQuestion } from './lobby';
afterEach(cleanup);
const leftItems = ['Apple', 'Pear'].map((textEn, i) => ({ id: `l${i}`, kind: 'text' as const, textEn, textRu: `Слева ${i}` }));
const rightItems = ['Red', 'Green'].map((textEn, i) => ({ id: `r${i}`, kind: 'text' as const, textEn, textRu: `Справа ${i}` }));
const mapping = [{ leftId: 'l0', rightId: 'r0' }, { leftId: 'l1', rightId: 'r1' }];
function question(): PlayerQuestion { return { state: 'ANSWERING', type: 'matching', questionId: 'q', text: 'Match', options: [], leftItems: leftItems.map(item => ({ id: item.id, kind: item.kind, text: item.textEn })), rightItems: rightItems.map(item => ({ id: item.id, kind: item.kind, text: item.textEn })), submission: { submitted: false }, timer: { serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), durationSeconds: 30, remainingMs: 30000, expired: false } }; }
test('tap-to-pair requires completeness, permits reassignment, retries and locks accepted/reconnected mappings', async () => {
  const original = globalThis.fetch; const posts: unknown[] = [];
  globalThis.fetch = async (_url, init) => { posts.push(JSON.parse(String(init?.body))); if (posts.length === 1) throw Error('ack lost'); return Response.json({ submitted: true, mapping }); };
  try {
    const props = { question: question(), roomId: 'room', token: 'secret', language: 'en' as const };
    const view = render(createElement(PlayerAnswer, props));
    const submit = () => view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    const tap = (left: string, right: RegExp) => { fireEvent.click(view.getByRole('button', { name: left })); fireEvent.click(view.getByRole('button', { name: right })); };
    assert.equal(submit().disabled, true);
    tap('1. Apple', /^Red/); assert.equal(submit().disabled, true);
    tap('2. Pear', /^Green/); assert.equal(submit().disabled, false);
    tap('1. Apple', /^Green/); assert.equal(submit().disabled, true); // displaces Pear
    tap('1. Apple', /^Red/); tap('2. Pear', /^Green/);
    fireEvent.click(submit()); await waitFor(() => assert.ok(view.getByRole('alert')));
    fireEvent.click(submit()); await waitFor(() => assert.ok(view.getByText('Answer submitted')));
    assert.deepEqual(posts, Array(2).fill({ token: 'secret', questionId: 'q', mapping }));
    assert.ok(view.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled));
    // Older reconnect data must not unlock an acknowledged answer.
    view.rerender(createElement(PlayerAnswer, props)); assert.equal(submit().disabled, true);
    view.unmount();
    const restored = render(createElement(PlayerAnswer, { ...props, question: { ...props.question, submission: { submitted: true, mapping } } }));
    assert.ok(restored.getByText('Apple → Red')); assert.ok(restored.getByText('Pear → Green'));
    assert.ok(restored.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled));
  } finally { globalThis.fetch = original; }
});
test('Matching bilingual Host/Screen content and localized Reveal show correct mapping and personal result', () => {
  const base = { state: 'ANSWERING' as const, roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Match', leftItems, rightItems, showOptionsOnScreen: true };
  const screen = render(createElement(QuestionContent, { question: base }));
  assert.equal(screen.queryByText('Apple', { exact: false }), null); assert.equal(screen.queryByText('Верные пары / Correct pairs'), null); screen.unmount();
  const host = render(createElement(QuestionContent, { host: true, question: { ...base, correctMapping: mapping } }));
  assert.ok(host.getByText('Верные пары / Correct pairs')); host.unmount();
  const reveal = render(createElement(PlayerRevealContent, { language: 'en', question: { ...question(), state: 'ANSWER_REVEAL', correctMapping: mapping, result: { outcome: 'wrong', points: 0 } } }));
  assert.ok(reveal.getByText('Incorrect')); assert.ok(reveal.getByText('Apple → Red')); reveal.unmount();
  const ru = render(createElement(PlayerRevealContent, { language: 'ru', question: { ...question(), leftItems: leftItems.map(item => ({ id: item.id, kind: item.kind, text: item.textRu })), rightItems: rightItems.map(item => ({ id: item.id, kind: item.kind, text: item.textRu })), state: 'ANSWER_REVEAL', correctMapping: mapping, result: { outcome: 'correct', points: 5 } } }));
  assert.ok(ru.getByText('Верно! +5')); assert.ok(ru.getByText('Слева 0 → Справа 0'));
});

test('Screen hides Matching sides before Reveal regardless of legacy flag, including paused content', () => {
  const base = { roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Match', leftItems, rightItems, showOptionsOnScreen: false };
  for (const state of ['QUESTION', 'ANSWERING'] as const) {
    const content = { ...base, state };
    const screen = render(createElement(QuestionContent, { question: content }));
    assert.ok(screen.getByText('Match')); assert.equal(screen.queryByText('Apple'), null);
    screen.unmount();
    const paused = render(createElement(QuestionContent, { question: content }));
    assert.equal(paused.queryByText('Apple'), null); paused.unmount();
    const host = render(createElement(QuestionContent, { host: true, question: content }));
    assert.ok(host.getByText('Apple', { exact: false })); host.unmount();
    const legacyContent = { ...content, showOptionsOnScreen: true };
    const shown = render(createElement(QuestionContent, { question: legacyContent }));
    assert.equal(shown.queryByText('Apple', { exact: false }), null); shown.unmount();
  }
  const reveal = render(createElement(QuestionContent, { question: { ...base, state: 'ANSWER_REVEAL', correctMapping: mapping } }));
  assert.ok(reveal.getByText('Верные пары / Correct pairs'));
  assert.ok(reveal.getByText('Apple', { exact: false }));
});
