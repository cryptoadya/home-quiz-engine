import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanup, render, waitFor, act, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';
import { resolveTheme } from './themes';

const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', themeId: 'default', state: 'LOBBY', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }

for (const path of ['/host/room', '/screen/room', '/play/ABCDE']) {
  for (const themeId of ['default', 'halloween', 'missing-theme', '', undefined, null]) {
    test(`${path} resolves theme ${String(themeId)} on reload and realtime recovery`, async () => {
      const live = Object.assign(new EventEmitter(), { disconnect() {}, connect() {} });
      mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
      const themedRoom = { ...room, themeId };
      if (path.startsWith('/play')) dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
      globalThis.fetch = async () => Response.json(path.startsWith('/play')
        ? { room: themedRoom, player, active: true } : { room: themedRoom, players: [player] });
      const view = show(path);
      await waitFor(() => assert.ok(view.getByText('Party')));
      const main = view.getByRole('main');
      assert.equal(main.dataset.theme, themeId === 'halloween' ? 'halloween' : 'default');
      assert.equal(main.style.getPropertyValue('--theme-text'), resolveTheme(themeId).tokens.text);
      await act(async () => { live.emit('lobby:state', { room: { ...themedRoom, state: 'ROUND_INTRO' }, players: [player] }); });
      assert.equal(main.dataset.theme, themeId === 'halloween' ? 'halloween' : 'default');
      assert.equal(main.style.getPropertyValue('--theme-background'), resolveTheme(themeId).tokens.background);
      assert.ok(view.getByText('Party'));
    });
  }
}

test('Admin preserves an unavailable selection through edits and allows selecting Default', async () => {
  const quiz = { id: 'quiz', title: 'Party', themeId: 'missing-theme', defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
  const updates: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (String(input).endsWith('/rounds')) return Response.json([]);
    if (init?.method === 'PUT') { updates.push(JSON.parse(String(init.body))); return Response.json(quiz); }
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz');
  await waitFor(() => assert.ok(view.getByDisplayValue('Party')));
  assert.equal(view.getByRole('main').dataset.theme, 'default');
  assert.equal((view.getByLabelText('Theme') as HTMLSelectElement).value, 'missing-theme');
  assert.match(view.getByText(/Theme unavailable/).textContent!, /Default/);
  assert.ok(view.getByRole('option', { name: 'Halloween' }));
  fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Edited' } });
  await waitFor(() => assert.equal(updates.length, 1));
  assert.equal(updates[0].themeId, 'missing-theme');
  fireEvent.change(view.getByLabelText('Theme'), { target: { value: 'default' } });
  await waitFor(() => assert.equal(updates.length, 2));
  assert.equal(updates[1].themeId, 'default');
  assert.equal(view.queryByText(/Theme unavailable/), null);
});

test('Halloween resolves locally and inherits missing optional configuration from Default', () => {
  const theme = resolveTheme('halloween');
  assert.equal(theme.manifest.id, 'halloween');
  assert.equal(theme.manifest.name, 'Halloween');
  assert.equal(theme.tokens.primary, '#ffad62');
  assert.equal(theme.tokens.font, 'system-ui, sans-serif');
  assert.equal(theme.tokens.correctBackground, '#eaf7ee');
  assert.deepEqual(theme.manifest.resources, []);
  for (const id of [undefined, null, '', 'unknown', '__proto__']) {
    assert.equal(resolveTheme(id).manifest.id, 'default');
    assert.equal(resolveTheme(id).tokens.primary, resolveTheme('default').tokens.primary);
  }
});

test('Admin switches Default and Halloween without changing quiz gameplay settings', async () => {
  const quiz = { id: 'quiz', title: 'Party', themeId: 'default', defaultAnswerTimeSeconds: 45, shuffleAnswers: true };
  const updates: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/validation')) return Response.json({ ready: false, problems: [] });
    if (String(input).endsWith('/rounds')) return Response.json([]);
    if (init?.method === 'PUT') { const update = JSON.parse(String(init.body)); updates.push(update); Object.assign(quiz, update); }
    return Response.json(quiz);
  };
  const view = show('/admin/quizzes/quiz');
  await waitFor(() => assert.ok(view.getByDisplayValue('Party')));
  for (const themeId of ['halloween', 'default']) {
    fireEvent.change(view.getByLabelText('Theme'), { target: { value: themeId } });
    assert.equal(view.getByRole('main').dataset.theme, themeId);
    await waitFor(() => assert.equal(updates.at(-1)?.themeId, themeId));
    assert.deepEqual(updates.at(-1), { title: 'Party', themeId, defaultAnswerTimeSeconds: 45, shuffleAnswers: true });
    assert.equal(view.queryByText(/Theme unavailable/), null);
  }
});

const phases = ['LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'PAUSED', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'] as const;
for (const path of ['/host/room', '/screen/room', '/play/ABCDE']) {
  for (const themeId of ['default', 'halloween']) {
    test(`${path} retains ${themeId} across every major phase using shared content`, async () => {
      const live = Object.assign(new EventEmitter(), { disconnect() {}, connect() {} });
      mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
      let state: string = 'LOBBY';
      const content = { roundNumber: 1, questionNumber: 1, questionCount: 1, nextAction: null, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', textRu: 'Вопрос', textEn: 'Question', options: [], leaderboard: [{ playerId: 'player', displayName: 'Alex', totalPoints: 3, rank: 1 }] };
      const playerGame = () => ['ANSWERING', 'ANSWER_REVEAL'].includes(state) ? { state, questionId: 'q', text: 'Question', options: [{ id: 'a', text: 'Answer' }], submission: { submitted: true, optionId: 'a' }, correctOptionId: 'a', result: { outcome: 'correct', points: 3 }, timer: { serverNow: '2026-01-01T00:00:00Z', deadlineAt: '2026-01-01T00:00:30Z', durationSeconds: 30, remainingMs: 0, expired: true } } : null;
      if (path.startsWith('/play')) dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
      globalThis.fetch = async () => Response.json(path.startsWith('/play') ? { room: { ...room, themeId, state }, player, active: true, game: playerGame() } : { room: { ...room, themeId, state }, players: [player] });
      const view = show(path);
      await waitFor(() => assert.ok(view.getByText('Party')));
      for (const phase of phases) {
        state = phase;
        await act(async () => { live.emit('lobby:state', { room: { ...room, themeId, state }, players: [player], game: phase === 'LOBBY' ? null : { ...content, state: phase, ...(phase === 'PAUSED' ? { pausedFromState: 'QUESTION', remainingMs: null } : {}) } }); });
        assert.equal(view.getByRole('main').dataset.theme, themeId, phase);
        assert.equal(view.getByRole('main').style.getPropertyValue('--theme-primary'), resolveTheme(themeId).tokens.primary, phase);
        if (path.startsWith('/play') && phase === 'ANSWERING') await waitFor(() => assert.ok(view.getByText('Answer')));
        if (path.startsWith('/play') && phase === 'ANSWER_REVEAL') await waitFor(() => assert.ok(view.getByText(/Correct.*3/)));
        if (!path.startsWith('/play') && phase === 'ROUND_INTRO') assert.ok(view.getByText('Round'));
        if (!path.startsWith('/play') && ['QUESTION', 'ANSWERING', 'ANSWER_REVEAL'].includes(phase)) assert.ok(view.getByRole('heading', { name: 'Question' }));
        if (!path.startsWith('/play') && ['LEADERBOARD', 'FINAL_RESULTS'].includes(phase)) assert.ok(view.getByRole('table'));
        if (!path.startsWith('/play') && phase === 'WINNER_SCREEN') assert.ok(view.container.querySelector('.winners'));
      }
    });
  }
}

// Relative luminance protects readability when palette tokens change.
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
for (const themeId of ['default', 'halloween']) test(`${themeId} text, answer states and controls have at least 4.5:1 contrast`, () => {
  const t = resolveTheme(themeId).tokens;
  for (const [foreground, background] of [[t.text, t.background], [t.muted, t.background], [t.primary, t.background], [t.onPrimary, t.primary], [t.danger, t.background], [t.correctText, t.correctBackground], [t.contentText, t.contentBackground], [t.contentMuted, t.contentBackground], [t.selectedText, t.selectedBackground], [t.wrongText, t.wrongBackground], [t.warningText, t.warningBackground], [t.text, t.surface], [t.muted, t.surface], [t.primary, t.surface], [t.text, t.glow], [t.muted, t.glow], [t.text, t.glowSecondary], [t.muted, t.glowSecondary]]) {
    const a = luminance(foreground), b = luminance(background);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${foreground} on ${background}`);
  }
});
