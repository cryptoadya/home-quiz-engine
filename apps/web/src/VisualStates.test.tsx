import './test-dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { BoundaryContent, QuestionContent, RoundIntroContent } from './GameContent';
import { ThemeSurface } from './themes/ThemeSurface';
import { ThemeScenery } from './themes/ThemeScenery';
import { resolveTheme } from './themes';
import { HalloweenDecoration, type DecorationKind } from './themes/halloween/HalloweenDecoration';
import { PlayerAnswerContent } from './PlayerAnswer';
import { PlayerRevealContent } from './PlayerReveal';
import type { PlayerReveal } from './lobby';

afterEach(cleanup);

test('static Screen scenery is optional, decorative, local and covered by the theme manifest', () => {
  const view = render(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(ThemeScenery, { kind: 'hall' })));
  const image = view.container.querySelector('img')!;
  assert.equal(view.queryByRole('img'), null);
  assert.ok(resolveTheme('halloween').manifest.resources.some(resource => image.src.endsWith(resource)));
  assert.ok(readFileSync(new URL(image.src)).length > 0);
  fireEvent.error(image);
  assert.equal(image.hidden, true, 'missing optional art leaves the solid theme background');
  view.rerender(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(ThemeScenery, { kind: 'quiet' })));
  assert.equal(view.container.querySelector('img')?.hidden, false);
  assert.equal(view.container.querySelector('.theme-scenery')?.getAttribute('data-kind'), 'quiet');
  for (const themeId of ['default', 'unavailable']) {
    view.rerender(createElement(ThemeSurface, { themeId }, createElement(ThemeScenery, { kind: 'finale' })));
    assert.equal(view.container.querySelector('.theme-scenery'), null);
  }
});

test('Halloween artwork uses transparent lossless WebP with matching intrinsic dimensions', () => {
  for (const kind of ['lobby', 'round', 'winner', 'waiting', 'reveal', 'player', 'corners'] as DecorationKind[]) {
    const view = render(createElement(HalloweenDecoration, { kind }));
    for (const image of view.container.querySelectorAll('img')) {
      assert.match(image.src, /\.webp$/);
      const file = readFileSync(new URL(image.src));
      assert.equal(file.toString('ascii', 0, 4), 'RIFF');
      assert.equal(file.toString('ascii', 8, 16), 'WEBPVP8L');
      assert.equal(file[20], 0x2f);
      // The lossless WebP header stores dimensions minus one and an alpha flag.
      const header = file.readUInt32LE(21);
      assert.equal(image.width, (header & 0x3fff) + 1);
      assert.equal(image.height, ((header >>> 14) & 0x3fff) + 1);
      assert.equal((header >>> 28) & 1, 1);
      assert.equal(image.alt, '');
      assert.equal(image.getAttribute('aria-hidden'), 'true');
    }
    view.unmount();
  }
});
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

test('Screen groups thirty standings without dropping players, changing ranks or sorting scores locally', () => {
  const leaderboard = Array.from({ length: 30 }, (_, index) => ({ playerId: String(index), displayName: index === 0 ? 'Максимилиан-Александр' : `Player ${index + 1}`, rank: index < 2 ? 1 : index + 1, totalPoints: index < 2 ? 100 : 100 - index }));
  const game = { state: 'FINAL_RESULTS' as const, roundNumber: 1, questionCount: 1, titleRu: '', titleEn: '', leaderboard };
  const view = render(createElement(BoundaryContent, { game, screen: true }));
  assert.equal(view.getAllByRole('table').length, 3);
  assert.deepEqual([...view.container.querySelectorAll('tbody th')].map(cell => cell.textContent), leaderboard.map(player => player.displayName));
  assert.equal(view.container.querySelectorAll('tr[data-rank="1"]').length, 2);
  view.rerender(createElement(BoundaryContent, { game }));
  assert.equal(view.getAllByRole('table').length, 1, 'Host retains its single scrollable list');
  view.rerender(createElement(BoundaryContent, { game: { ...game, state: 'WINNER_SCREEN', leaderboard: leaderboard.map(player => ({ ...player, rank: 1, totalPoints: 100 })) }, screen: true }));
  assert.equal(view.container.querySelectorAll('.winner-card').length, 30);
  assert.equal(view.container.querySelector('.winner-stage')?.getAttribute('data-many-winners'), 'true');
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
  for (const state of ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'] as const) {
    view.rerender(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(BoundaryContent, { game: { ...game, state } })));
    assert.equal(view.container.querySelectorAll('.halloween-art--waiting').length, 1);
    assert.ok(view.getByRole('table'));
    assert.ok(view.getByRole('rowheader', { name: 'Alex' }));
    assert.ok(view.getByRole('rowheader', { name: 'Sam' }));
  }
  view.rerender(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(BoundaryContent, { game: { ...game, state: 'WINNER_SCREEN', leaderboard: leaderboard.slice(0, 2) } })));
  assert.equal(view.container.querySelectorAll('.halloween-art--winner').length, 1);
  assert.equal(view.container.querySelector('.halloween-art--waiting'), null);
  assert.equal(view.container.querySelector('.party-decoration'), null);
  assert.equal(view.container.querySelectorAll('.winner-card').length, 2);
  assert.ok(view.getByText('Alex'));
  assert.ok(view.getByText('Sam'));
});

test('Halloween Reveal has a decorative ghost outside answer content and keeps Host compact', () => {
  const question = { state: 'ANSWER_REVEAL' as const, roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question', options: [{ textRu: 'Ответ', textEn: 'Answer', isCorrect: true }] };
  const view = render(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(QuestionContent, { question })));
  const ghost = view.container.querySelector('.halloween-art--reveal');
  assert.ok(ghost?.closest('.question-meta'));
  assert.equal(ghost?.closest('.game-options'), null);
  assert.equal(view.queryByRole('img'), null);
  assert.ok(view.getByText('Правильный ответ / Correct answer'));
  view.rerender(createElement(ThemeSurface, { themeId: 'halloween' }, createElement(QuestionContent, { question, host: true })));
  assert.equal(view.container.querySelector('.halloween-art--reveal'), null);
  view.rerender(createElement(ThemeSurface, { themeId: 'default' }, createElement(QuestionContent, { question })));
  assert.equal(view.container.querySelector('.halloween-art'), null);
});
