import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { BoundaryContent, RoundIntroContent } from './GameContent';
import { ThemeSurface } from './themes/ThemeSurface';
import { PlayerAnswerContent } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import type { PlayerReveal } from './lobby';

afterEach(cleanup);
const question = { state: 'ANSWERING' as const, questionId: 'q', text: 'Pick one', options: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }], submission: { submitted: false as const } };

test('selection stays unmistakable after acknowledgement and restored submission', async () => {
  const props = { question, language: 'en' as const, seconds: 30, onSubmit: async () => ({ submitted: true as const, optionId: 'a' }) };
  const view = render(createElement(PlayerAnswerContent, props));
  fireEvent.click(view.getByLabelText('Alpha'));
  assert.equal(view.getByLabelText('Alpha').closest('label')?.dataset.selected, 'true');
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  await waitFor(() => assert.equal(view.container.querySelector<HTMLElement>('.player-answer')?.dataset.answerState, 'submitted'));
  assert.equal((view.getByLabelText('Alpha') as HTMLInputElement).disabled, true);
  assert.equal(view.getByLabelText('Alpha').closest('label')?.dataset.selected, 'true');
  assert.ok(view.getByRole('status').classList.contains('submitted'));
  view.unmount();
  const restored = render(createElement(PlayerAnswerContent, { ...props, question: { ...question, submission: { submitted: true, optionId: 'b' } } }));
  assert.equal(restored.getByLabelText('Beta').closest('label')?.dataset.selected, 'true');
  assert.equal(restored.getByLabelText('Alpha').closest('label')?.dataset.selected, undefined);
  assert.equal((restored.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
});

test('an expired draft has a distinct disabled presentation without becoming submitted', () => {
  const view = render(createElement(PlayerAnswerContent, { question, language: 'en', seconds: 0, onSubmit: async () => { throw Error('Must not submit'); } }));
  assert.equal(view.container.querySelector<HTMLElement>('.player-answer')?.dataset.answerState, 'disabled');
  assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByText('Answer submitted'), null);
});

for (const outcome of ['correct', 'wrong', 'unanswered'] as const) test(`personal Reveal exposes ${outcome} styling and keeps its text result`, () => {
  const reveal: PlayerReveal = { ...question, state: 'ANSWER_REVEAL', correctOptionId: 'a', result: { outcome, points: outcome === 'correct' ? 2 : 0 } };
  const view = render(createElement(PlayerRevealContent, { question: reveal, language: 'en' }));
  assert.equal(view.container.querySelector<HTMLElement>('.player-reveal')?.dataset.outcome, outcome);
  assert.match(view.getByRole('status').textContent!, outcome === 'correct' ? /Correct! \+2/ : outcome === 'wrong' ? /Incorrect/ : /No answer/);
});

test('scoreboard preserves shared first places and multiple Winner cards', () => {
  const leaderboard = [
    { playerId: 'a', displayName: 'Alex', totalPoints: 8, rank: 1 },
    { playerId: 'b', displayName: 'Sam', totalPoints: 8, rank: 1 },
    { playerId: 'c', displayName: 'Jo', totalPoints: 5, rank: 3 },
  ];
  const game = { state: 'FINAL_RESULTS' as const, roundNumber: 1, questionCount: 1, titleRu: '', titleEn: '', nextAction: null, leaderboard };
  const view = render(createElement(BoundaryContent, { game }));
  assert.equal(view.container.querySelectorAll('tr[data-rank="1"]').length, 2);
  assert.equal(view.container.querySelectorAll('tr[data-rank="3"]').length, 1);
  assert.ok(view.getByRole('rowheader', { name: 'Alex' }));
  view.rerender(createElement(BoundaryContent, { game: { ...game, state: 'WINNER_SCREEN', leaderboard: leaderboard.slice(0, 2) } }));
  assert.equal(view.container.querySelectorAll('.winner-card').length, 2);
  assert.equal(view.container.querySelector('.party-decoration')?.getAttribute('aria-hidden'), 'true');
  assert.ok(view.getByText('Alex'));
  assert.ok(view.getByText('Sam'));
});

test('Halloween round decoration preserves optional author art and falls back to Default decoration', () => {
  const round = { state: 'ROUND_INTRO' as const, roundNumber: 1, questionCount: 1, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', artUrl: '/media/author-art.png' };
  const view = render(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(RoundIntroContent, { round })));
  assert.ok(view.container.querySelector('.halloween-art--round'));
  assert.equal(view.getByRole('img', { name: 'Round art' }).getAttribute('src'), round.artUrl);
  assert.equal(view.getAllByRole('img').length, 1, 'decoration stays out of accessibility reading order');
  view.rerender(createElement(ThemeSurface, { themeId: 'unavailable' }, createElement(RoundIntroContent, { round })));
  assert.equal(view.container.querySelector('.halloween-art'), null);
  assert.ok(view.container.querySelector('.party-decoration'));
  assert.equal(view.getByRole('img', { name: 'Round art' }).getAttribute('src'), round.artUrl);
});

test('Halloween standings retain one rank per row, including ties, and celebrate every winner', () => {
  const leaderboard = [
    { playerId: 'a', displayName: 'Alex', totalPoints: 8, rank: 1 },
    { playerId: 'b', displayName: 'Sam', totalPoints: 8, rank: 1 },
    { playerId: 'c', displayName: 'Jo', totalPoints: 5, rank: 3 },
  ];
  const game = { state: 'LEADERBOARD' as const, roundNumber: 1, questionCount: 1, titleRu: '', titleEn: '', nextAction: null, leaderboard };
  const view = render(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(BoundaryContent, { game })));
  assert.deepEqual([...view.container.querySelectorAll('.rank-badge')].map(el => el.textContent), ['1', '1', '3']);
  assert.equal(view.container.querySelector('.halloween-art'), null);
  view.rerender(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(BoundaryContent, { game: { ...game, state: 'WINNER_SCREEN', leaderboard: leaderboard.slice(0, 2) } })));
  assert.ok(view.container.querySelector('.halloween-art--winner'));
  assert.equal(view.container.querySelector('.party-decoration'), null);
  assert.equal(view.container.querySelectorAll('.winner-card').length, 2);
  assert.ok(view.getByText('Alex'));
  assert.ok(view.getByText('Sam'));
});
