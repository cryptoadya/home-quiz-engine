import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const room = { id: 'room', code: 'ABCDE', quizTitle: 'Party', state: 'QUESTION', closedAt: null };
const question = { state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question text', options: [] };
const timer = (now: number, remainingMs: number) => ({ serverNow: new Date(now).toISOString(), deadlineAt: new Date(now + remainingMs).toISOString(), remainingMs, durationSeconds: 12, expired: false });
const paused = { room: { ...room, state: 'PAUSED' }, game: { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 10000 } };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
function socket() {
  const live = Object.assign(new EventEmitter(), { connect() {}, disconnect() {} });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  return live;
}

for (const state of ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'LOBBY', 'WINNER_SCREEN']) {
  test(`Host Pause eligibility: ${state}`, async () => {
    socket();
    globalThis.fetch = async () => Response.json({ room: { ...room, state } });
    const view = show('/host/room');
    await waitFor(() => assert.ok(view.getByText('Party')));
    assert.equal(Boolean(view.queryByRole('button', { name: 'Пауза' })), !['LOBBY', 'WINNER_SCREEN'].includes(state));
  });
}

test('Host Pause hides progression, reload restores pause, Resume restores prior surface, and closure wins', async () => {
  const live = socket();
  let snapshot = { room, game: question } as unknown;
  const commands: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      commands.push(String(url).split('/').at(-1)!);
      snapshot = commands.at(-1) === 'pause' ? { ...paused, game: { ...paused.game, pausedFromState: 'QUESTION', remainingMs: null } } : { room, game: question };
    }
    return Response.json(snapshot);
  };
  let view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Начать вопрос' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Пауза' })); });
  assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), ['Продолжить', 'Завершить игру']);
  view.unmount(); view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Продолжить' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Продолжить' })); });
  assert.ok(view.getByRole('button', { name: 'Начать вопрос' }));
  assert.deepEqual(commands, ['pause', 'resume']);
  await act(async () => { live.emit('lobby:state', { ...paused, room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText('Комната закрыта'));
  assert.equal(view.queryByRole('button'), null);
});

for (const audience of ['host', 'screen']) test(`${audience} pause removes countdown through elapsed time and reload; Resume uses new timer`, async t => {
  const live = socket();
  let elapsed = 0;
  mock.method(performance, 'now', () => elapsed);
  let snapshot: unknown = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(0, 12000) } };
  globalThis.fetch = async () => Response.json(snapshot);
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Flush the HTTP render and countdown interval effect before advancing the clock.
  let view!: ReturnType<typeof show>;
  await act(async () => { view = show(`/${audience}/room`); });
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '12'));
  elapsed = 2000;
  await act(async () => { t.mock.timers.tick(2000); });
  assert.equal(view.getByRole('timer').textContent, '10');
  snapshot = paused;
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.equal(view.queryByRole('timer'), null);
  if (audience === 'screen') assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
  elapsed = 62000;
  await act(async () => { t.mock.timers.tick(60000); });
  view.unmount(); view = show(`/${audience}/room`);
  await act(async () => {});
  assert.equal(view.queryByRole('timer'), null);
  snapshot = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(62000, 10000) } };
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.equal(view.getByRole('timer').textContent, '10');
  elapsed = 63000;
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(view.getByRole('timer').textContent, '9');
  await act(async () => { live.emit('lobby:state', { ...paused, room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText(audience === 'host' ? 'Комната закрыта' : /Room closed/));
  assert.equal(view.queryByRole('heading', { name: 'Пауза / Paused' }), null);
});

for (const language of ['ru', 'en']) for (const reload of [false, true]) test(`Player ${language} pause hides answers; reload=${reload} and Resume refetch preserve accepted answer and new deadline`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ANSWERING';
  let remaining = 12000;
  let pending: ((response: Response) => void) | undefined;
  const identity = () => ({ room: { ...room, state: phase }, active: true, player: { id: 'p', name: 'Alex', language },
    game: phase === 'ANSWERING' ? { state: 'ANSWERING', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: true, optionId: 'a' }, timer: timer(62000, remaining) } : null });
  globalThis.fetch = async () => Response.json(identity());
  let view = show('/play/ABCDE');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '12'));
  // HTTP-rendered content can appear before the passive socket effect subscribes.
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  phase = 'PAUSED';
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  const label = language === 'ru' ? 'Пауза' : 'Paused';
  assert.ok(view.getByText(label));
  assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('radio'), null);
  if (reload) {
    view.unmount(); view = show('/play/ABCDE');
    await waitFor(() => assert.ok(view.getByText(label)));
    await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  }
  phase = 'ANSWERING'; remaining = 10000;
  globalThis.fetch = () => new Promise(resolve => { pending = resolve; });
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  assert.equal(view.queryByRole('timer'), null);
  await act(async () => { pending!(Response.json(identity())); });
  assert.equal(view.getByRole('timer').textContent, '10');
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
  await act(async () => { live.emit('lobby:state', { room: { ...paused.room, closedAt: 'now' } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
  assert.equal(view.queryByText(label), null);
});

for (const audience of ['host', 'screen']) test(`${audience} disconnect pause renders the appropriate private/public resolution controls`, async () => {
  const live = socket();
  const snapshot = { ...paused, game: { ...paused.game, reason: 'player_disconnect', disconnectedPlayer: { id: 'a', name: 'Alice' } } };
  globalThis.fetch = async () => Response.json({ room, game: question });
  const view = show(`/${audience}/room`);
  await waitFor(() => assert.ok(view.getByText('Party')));
  await act(async () => { live.emit('lobby:state', snapshot); });
  if (audience === 'host') {
    assert.ok(view.getByText('Alice потерял(а) связь.'));
    assert.ok(view.getByText('Игра приостановлена.'));
    assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), ['Продолжить с игроком', 'Продолжить без игрока', 'Завершить игру']);
    assert.equal((view.getByRole('button', { name: 'Продолжить с игроком' }) as HTMLButtonElement).disabled, true);
  } else {
    assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
    assert.equal(view.queryByText(/Alice/), null);
    assert.equal(view.queryByRole('button'), null);
  }
});

test('Player authenticates every socket reconnect, exposes subscription failure and retains durable identity', async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room: paused.room, active: true, player: { id: 'a', name: 'Alice', language: 'en' }, game: null });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Paused')));
  await waitFor(() => assert.equal(live.listenerCount('connect'), 1));
  const subscriptions: unknown[] = [];
  live.on('lobby:subscribe', input => subscriptions.push(input));
  await act(async () => { live.emit('connect'); live.emit('lobby:error', { error: 'Invalid player reconnect token.' }); });
  assert.match(view.getByRole('alert').textContent!, /Invalid player reconnect token.*Reload/);
  assert.ok(dom.window.localStorage.getItem('quiz-player:ABCDE'));
  await act(async () => { live.emit('disconnect'); live.emit('connect'); live.emit('lobby:state', { room: paused.room }); });
  assert.deepEqual(subscriptions, [{ roomId: 'room', audience: 'player', token: 'secret' }, { roomId: 'room', audience: 'player', token: 'secret' }]);
  assert.equal(view.queryByRole('alert'), null);
  assert.ok(view.getByText('Paused')); assert.equal(view.queryByRole('radio'), null);
});

test('accepted Player answer survives socket disconnect without displaying an invented Pause', async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ANSWERING' }, active: true, player: { id: 'a', name: 'Alice', language: 'en' },
    game: { state: 'ANSWERING', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: true, optionId: 'a' }, timer: timer(Date.now(), 30000) } });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByRole('radio')));
  await waitFor(() => assert.equal(live.listenerCount('disconnect'), 1));
  await act(async () => { live.emit('disconnect'); });
  assert.equal(view.queryByText('Paused'), null);
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, true);
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, true);
});

test('Host reconnect enables Wait without confirmation and resumes; Continue requires explicit confirmation', async () => {
  const live = socket();
  const disconnect = (present: boolean) => ({ ...paused, game: { ...paused.game, reason: 'player_disconnect', disconnectedPlayer: { id: 'a', name: 'Alice', present } } });
  let snapshot: unknown = disconnect(false);
  const commands: string[] = [];
  const confirmations: string[] = [];
  let confirm = false;
  mock.method(dom.window, 'confirm', (message: string) => { confirmations.push(String(message)); return confirm; });
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      commands.push(String(url).split('/').at(-1)!);
      snapshot = { room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer: timer(Date.now(), 10000) } };
    }
    return Response.json(snapshot);
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Продолжить с игроком' })));
  assert.equal((view.getByRole('button', { name: 'Продолжить с игроком' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByRole('button', { name: 'Продолжить' }), null);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Продолжить без игрока' })); });
  assert.deepEqual(commands, []);
  assert.match(confirmations[0], /Продолжить без игрока Alice.*этот вопрос.*0 очков.*со следующего вопроса/);
  snapshot = disconnect(true);
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.ok(view.getByText(/Alice снова подключён/));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Продолжить с игроком' })); });
  assert.deepEqual(commands, ['wait-for-player']); assert.equal(confirmations.length, 1);
  assert.equal(view.getByRole('timer').textContent, '10');
  snapshot = disconnect(false);
  await act(async () => { live.emit('lobby:state', snapshot); });
  confirm = true;
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Продолжить без игрока' })); });
  assert.deepEqual(commands, ['wait-for-player', 'continue-without-player']);
  assert.ok(view.getByRole('button', { name: 'Пауза' }));
});

for (const language of ['ru', 'en']) test(`excluded Player ${language} has no controls and next question restores them`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let excluded = true;
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ANSWERING' }, active: true, player: { id: 'a', name: 'Alice', language },
    game: { state: 'ANSWERING', questionId: excluded ? 'q1' : 'q2', excluded, text: 'Pick', options: excluded ? [] : [{ id: 'a', text: 'Apple' }], submission: { submitted: false }, timer: timer(Date.now(), 10000) } });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Этот вопрос продолжен без вас' : 'This question continued without you')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  assert.equal(view.queryByRole('radio'), null); assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('button', { name: /Submit|Отправить/ }), null);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' } }); });
  excluded = false;
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' } }); });
  await waitFor(() => assert.ok(view.getByRole('radio')));
  assert.equal((view.getByRole('radio') as HTMLInputElement).disabled, false);
});

for (const kind of ['single', 'multiple', 'yes-no', 'matching']) test(`${kind} unsent draft survives Pause and Wait/Resume`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ANSWERING';
  const game = { state: 'ANSWERING', questionId: 'q', text: 'Pick', submission: { submitted: false },
    ...(kind === 'multiple' ? { type: 'multiple_choice' } : kind === 'matching' ? { type: 'matching',
      leftItems: [{ id: 'l1', kind: 'text', text: 'Apple' }, { id: 'l2', kind: 'text', text: 'Pear' }],
      rightItems: [{ id: 'r1', kind: 'text', text: 'Red' }, { id: 'r2', kind: 'text', text: 'Green' }] } : {}),
    options: [{ id: 'a', text: kind === 'yes-no' ? 'Yes' : 'First' }, { id: 'b', text: kind === 'yes-no' ? 'No' : 'Second' }], timer: timer(Date.now(), 30000) };
  globalThis.fetch = async () => Response.json({ room: { ...room, state: phase }, active: true, player: { id: 'p', name: 'Alex', language: 'en' }, game: phase === 'ANSWERING' ? game : null });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Pick')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  if (kind === 'matching') {
    fireEvent.click(view.getByRole('button', { name: '1. Apple' }));
    fireEvent.click(view.getByRole('button', { name: 'Red' }));
  } else {
    fireEvent.click(view.getByLabelText(game.options[1].text));
    if (kind === 'multiple') fireEvent.click(view.getByLabelText('First'));
  }
  for (let cycle = 0; cycle < 2; cycle++) {
    phase = 'PAUSED';
    await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
    assert.ok(view.getByText('Paused'));
    assert.equal(view.queryByText('Pick'), null);
    phase = 'ANSWERING';
    await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
    await waitFor(() => assert.ok(view.getByText('Pick')));
    if (kind === 'matching') {
      assert.ok(view.getByText('Apple → Red'));
      assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
    } else {
      assert.equal((view.getByLabelText(game.options[1].text) as HTMLInputElement).checked, true);
      assert.equal((view.getByLabelText(game.options[0].text) as HTMLInputElement).checked, kind === 'multiple');
    }
  }
});

for (const boundary of ['next question', 'accepted Submit', 'excluded', 'closed', 'finished', 'identity']) test(`draft clears after ${boundary}`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ANSWERING', questionId = 'q', playerId = 'p';
  let excluded = false, closedAt: string | null = null;
  globalThis.fetch = async url => String(url).endsWith('/answers') ? Response.json({ submitted: true, optionId: 'a' }) : Response.json({
    room: { ...room, state: phase, closedAt }, active: true, player: { id: playerId, name: 'Alex', language: 'en' },
    game: phase === 'ANSWERING' ? { state: 'ANSWERING', questionId, excluded, text: 'Pick', options: [{ id: 'a', text: 'Apple' }], submission: { submitted: false }, timer: timer(Date.now(), 30000) } : null });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByRole('radio')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  fireEvent.click(view.getByRole('radio'));
  const refresh = async () => { await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase, closedAt } }); }); };
  if (boundary === 'accepted Submit') {
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));
    await waitFor(() => assert.ok(view.getByText('Answer submitted')));
  }
  phase = 'PAUSED'; await refresh();
  if (boundary === 'next question') questionId = 'q2';
  if (boundary === 'identity') playerId = 'other';
  if (boundary === 'excluded') { excluded = true; phase = 'ANSWERING'; await refresh(); assert.ok(view.getByText('This question continued without you')); }
  if (boundary === 'closed') { closedAt = 'now'; await refresh(); }
  if (boundary === 'finished') { phase = 'FINAL_RESULTS'; await refresh(); }
  // Re-present an editable projection with the same option IDs to detect retained draft state.
  excluded = false; closedAt = null; phase = 'ANSWERING'; await refresh();
  await waitFor(() => assert.ok(view.getByRole('radio')));
  assert.equal((view.getByRole('radio') as HTMLInputElement).checked, false);
});

for (const state of ['QUESTION', 'ANSWERING', 'ANSWER_REVEAL']) test(`Screen renders text-only paused ${state} under bilingual Pause`, async () => {
  socket();
  globalThis.fetch = async () => Response.json({ ...paused, game: { ...paused.game, pausedFromState: state, content: {
    ...question, questionId: 'q', state, showOptionsOnScreen: true,
    options: [{ textRu: 'Ответ', textEn: 'Answer', ...(state === 'ANSWER_REVEAL' ? { isCorrect: true } : {}) }],
    ...(state === 'ANSWER_REVEAL' ? { explanationRu: 'Почему', explanationEn: 'Because' } : {}),
  } } });
  const view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' })));
  assert.equal(Boolean(view.queryByText('Question text')), state !== 'QUESTION');
  assert.equal(Boolean(view.queryByText('Вопрос')), state !== 'QUESTION');
  if (state === 'QUESTION') assert.ok(view.getByText('Следующий вопрос готов / Next question is ready'));
  assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
  assert.equal(Boolean(view.queryByText('Answer')), state === 'ANSWER_REVEAL');
  assert.equal(Boolean(view.queryByText('Правильный ответ / Correct answer')), state === 'ANSWER_REVEAL');
  assert.equal(Boolean(view.queryByText('Because')), state === 'ANSWER_REVEAL');
  assert.equal(view.queryByRole('timer'), null);
});

for (const audience of ['host', 'screen'] as const) {
  test(`${audience} keeps Round Intro title, descriptions and art under Pause`, async () => {
    socket();
    const content = { state: 'ROUND_INTRO', roundNumber: 1, questionCount: 2, titleRu: 'Раунд', titleEn: 'Round', descriptionRu: 'Описание', descriptionEn: 'Description', artUrl: '/round-art.png' };
    globalThis.fetch = async () => Response.json({ ...paused, game: { ...paused.game, pausedFromState: 'ROUND_INTRO', remainingMs: null, content } });
    const view = show(`/${audience}/room`);
    await waitFor(() => assert.ok(view.getByText('Description')));
    assert.ok(view.getByText('Round'));
    assert.ok(view.getByText('Описание'));
    assert.equal(view.getByRole('img', { name: 'Round art' }).getAttribute('src'), '/round-art.png');
    if (audience === 'host') {
      assert.ok(view.getByText('Игра приостановлена.'));
      assert.equal(view.queryByRole('button', { name: 'Начать раунд' }), null);
      assert.ok(view.getByRole('button', { name: 'Продолжить' }));
    } else assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
  });

  for (const state of ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'] as const) {
    test(`${audience} keeps ${state} content under Pause without progression`, async () => {
      socket();
      const content = { state, roundNumber: 1, questionCount: 2, titleRu: 'Раунд', titleEn: 'Round', nextAction: 'show-winner', leaderboard: state === 'ROUND_END' ? undefined : [{ playerId: 'p', displayName: 'Alice', totalPoints: 7, rank: 1 }] };
      globalThis.fetch = async () => Response.json({ ...paused, game: { ...paused.game, pausedFromState: state, remainingMs: null, content } });
      const view = show(`/${audience}/room`);
      await waitFor(() => assert.ok(view.getByText(state === 'ROUND_END' ? 'Раунд завершён / Round complete' : state === 'LEADERBOARD' ? 'Таблица лидеров / Leaderboard' : 'Финальные результаты / Final results')));
      if (state === 'ROUND_END') assert.ok(view.getByText('Round'));
      else {
        assert.ok(view.getByRole('table'));
        assert.ok(view.getByText('Alice'));
        assert.ok(view.getByText('7'));
      }
      if (audience === 'host') {
        assert.ok(view.getByText('Игра приостановлена.'));
        assert.equal(view.queryByRole('button', { name: 'Показать победителей' }), null);
      } else assert.ok(view.getByRole('heading', { name: 'Пауза / Paused' }));
    });
  }
}
