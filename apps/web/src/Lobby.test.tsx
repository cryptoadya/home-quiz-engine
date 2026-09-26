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

const room = { id: 'room', code: 'ABCDE', quizId: 'quiz', quizTitle: 'Party', state: 'LOBBY', createdAt: 'now', closedAt: null };
const player = { id: 'player', name: 'Alex', language: 'en', joinedAt: 'now' };
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); });
function show(path: string) { return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))); }
function socket() {
  const events = new EventEmitter();
  const transport = Object.assign(events, { disconnect() {}, connect() {} });
  mock.method(lobbyTransport, 'connect', () => transport as unknown as Socket);
  return transport;
}

test('Host loads roster, applies realtime snapshots and resubscribes for authoritative recovery', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json({ room, players: [player] });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText(/Alex/)));
  assert.ok(view.getByText(/EN/));
  assert.ok(view.getByText(/Players: 1/));
  live.on('lobby:subscribe', input => {
    assert.deepEqual(input, { roomId: 'room', audience: 'host' });
    live.emit('lobby:state', { room, players: [player, { ...player, id: 'two', name: 'Jane' }] });
  });
  await act(async () => { live.emit('connect'); });
  assert.ok(view.getByText(/Jane/));
  await act(async () => { live.emit('disconnect'); });
  assert.ok(view.getByText('Reconnecting…'));
  live.removeAllListeners('lobby:subscribe');
  live.on('lobby:subscribe', () => live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }));
  await act(async () => { live.emit('connect'); });
  assert.ok(view.getByText('Room closed'));
});

test('Screen renders count, same-room bilingual QR links, LAN origin and live closure', async () => {
  dom.reconfigure({ url: 'http://192.168.1.50:5173/screen/room' });
  try {
    const live = socket();
    globalThis.fetch = async () => Response.json({ room, players: [player] });
    const view = show('/screen/room');
    await waitFor(() => assert.ok(view.getByText('ABCDE')));
    assert.ok(view.getByText(/Players: 1/));
    for (const lang of ['ru', 'en']) {
      const link = view.getByRole('link', { name: lang.toUpperCase() }) as HTMLAnchorElement;
      assert.equal(link.href, `http://192.168.1.50:5173/play/ABCDE?lang=${lang}`);
      assert.ok(link.querySelector('svg'));
    }
    await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }); });
    assert.ok(view.getByText(/Room closed/));
    assert.equal(view.queryByRole('link', { name: 'RU' }), null);
  } finally { dom.reconfigure({ url: 'http://localhost' }); }
});

test('query preference initializes language and restored Player reacts to live closure without roster', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json(room);
  let view = show('/play/ABCDE?lang=en');
  await waitFor(() => assert.ok(view.getByLabelText('Language')));
  assert.equal((view.getByLabelText('Language') as HTMLSelectElement).value, 'en');
  view.unmount();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room, player, active: true });
  view = show('/play/ABCDE?lang=ru');
  await waitFor(() => assert.ok(view.getByText('Waiting for the host…')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  live.on('lobby:subscribe', input => assert.deepEqual(input, { roomId: 'room', audience: 'player' }));
  await act(async () => { live.emit('connect'); live.emit('lobby:state', { room: { ...room, closedAt: 'now' } }); });
  assert.ok(view.getByText('Room closed'));
});

test('a delayed initial HTTP response cannot overwrite a newer socket snapshot', async () => {
  const live = socket();
  let finish!: (value: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const view = show('/host/room');
  await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }); });
  await act(async () => { finish(Response.json({ room, players: [] })); });
  assert.ok(view.getByText('Room closed'));
  assert.ok(view.getByText(/Alex/));
});

test('localhost Screen warns about phone reachability', async () => {
  socket();
  globalThis.fetch = async () => Response.json({ room, players: [] });
  const view = show('/screen/room');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /LAN address/));
});


test('Host requires players and confirmation; Start success removes control and updates state', async () => {
  const live = socket();
  let starts = 0;
  let confirmed = false;
  mock.method(window, 'confirm', (message: string) => {
    assert.match(message, /player list and quiz content will be locked/i);
    return confirmed;
  });
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), '/api/rooms/room/start');
      starts++;
      return Response.json({ ...room, state: 'ROUND_INTRO' });
    }
    return Response.json({ room: starts ? { ...room, state: 'ROUND_INTRO' } : room, players: [] });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText(/Players: 0/)));
  assert.equal(view.queryByRole('button', { name: 'Start Game' }), null);
  await act(async () => { live.emit('lobby:state', { room, players: [player] }); });
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  assert.equal(starts, 0);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  await waitFor(() => assert.ok(view.getByText('Round Intro')));
  assert.equal(starts, 1);
  assert.equal(view.queryByRole('button', { name: 'Start Game' }), null);
});

test('Host keeps Start failure visible when a realtime snapshot arrives', async () => {
  const live = socket();
  mock.method(window, 'confirm', () => true);
  globalThis.fetch = async (_url, init) => init?.method === 'POST'
    ? Response.json({ error: 'Quiz is not ready. Review the validation problems.' }, { status: 409 })
    : Response.json({ room, players: [player] });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Start Game' })));
  fireEvent.click(view.getByRole('button', { name: 'Start Game' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Quiz is not ready/));
  await act(async () => { live.emit('lobby:state', { room, players: [player] }); });
  assert.match(view.getByRole('alert').textContent!, /Quiz is not ready/);
});

test('Screen leaves QR and join instructions when Start is broadcast and on reload', async () => {
  const live = socket();
  globalThis.fetch = async () => Response.json({ room, players: [player] });
  let view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'RU' })));
  const started = { room: { ...room, state: 'ROUND_INTRO', quizTitle: 'Frozen title' }, players: [player], game: introGame };
  await act(async () => { live.emit('lobby:state', started); });
  assert.ok(view.getByText('Frozen round'));
  assert.ok(view.getByText('Замороженный раунд'));
  assert.equal(view.queryByRole('link', { name: 'RU' }), null);
  assert.equal(view.queryByText(/scan a QR/), null);
  assert.equal(view.container.querySelector('svg'), null);
  view.unmount();
  globalThis.fetch = async () => Response.json(started);
  view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('Frozen round')));
  assert.ok(view.getByText('Frozen title'));
  assert.equal(view.container.querySelector('svg'), null);
});

for (const language of ['ru', 'en']) test(`Player ${language} leaves waiting on Start and restores starting state`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room, player: { ...player, language }, active: true });
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Ожидайте ведущего…' : 'Waiting for the host…')));
  const started = { ...room, state: 'ROUND_INTRO' };
  await act(async () => { live.emit('lobby:state', { room: started }); });
  assert.ok(view.getByText(language === 'ru' ? 'Раунд начинается…' : 'Round is starting…'));
  view.unmount();
  globalThis.fetch = async () => Response.json({ room: started, player: { ...player, language }, active: true });
  view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Раунд начинается…' : 'Round is starting…')));
});

test('direct code identifies a started game and does not offer joining', async () => {
  socket();
  globalThis.fetch = async () => Response.json({ ...room, state: 'ROUND_INTRO' });
  const view = show('/play/ABCDE');
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /started|accepting players/i));
  assert.equal(view.queryByRole('button', { name: 'Join' }), null);
});

const introGame = { state: 'ROUND_INTRO', roundNumber: 1, titleRu: 'Замороженный раунд', titleEn: 'Frozen round', descriptionRu: 'Описание', descriptionEn: 'Description', questionCount: 2 };
const questionGame = { state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 2, textRu: 'Первый вопрос', textEn: 'First question', points: 3, answerTimeSeconds: 12,
  options: [{ textRu: 'Один', textEn: 'One', isCorrect: false }, { textRu: 'Два', textEn: 'Two', isCorrect: true }] };

test('Host reload restores Round Intro and Start Round displays current question and correct option', async () => {
  socket();
  let started = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), '/api/rooms/room/start-round');
      started = true;
      return Response.json({ ...room, state: 'QUESTION' });
    }
    assert.equal(String(url), '/api/rooms/room/game/host');
    return Response.json({ room: { ...room, state: started ? 'QUESTION' : 'ROUND_INTRO' }, players: [player], game: started ? questionGame : introGame });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText('Frozen round')));
  assert.ok(view.getByText('Замороженный раунд'));
  assert.ok(view.getByText('Description'));
  assert.ok(view.getByText(/Questions: 2/));
  fireEvent.click(view.getByRole('button', { name: 'Start Round' }));
  await waitFor(() => assert.ok(view.getByText('First question')));
  assert.ok(view.getByText('Первый вопрос'));
  assert.match(view.getByText('Correct answer').parentElement!.textContent!, /Two/);
  assert.ok(view.getByText(/Points: 3/));
  assert.ok(view.getByText(/Answer time: 12/));
  assert.equal(view.queryByRole('button', { name: 'Start Round' }), null);
});

for (const showOptionsOnScreen of [false, true]) test(`Screen reload presents bilingual question, options ${showOptionsOnScreen}, no correctness`, async () => {
  socket();
  const { points, answerTimeSeconds, options, ...question } = questionGame;
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'QUESTION' }, players: [player], game: {
    ...question, showOptionsOnScreen, ...(showOptionsOnScreen ? { options: options.map(({ textRu, textEn }) => ({ textRu, textEn })) } : {}),
  } });
  const view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('First question')));
  assert.ok(view.getByText('Первый вопрос'));
  assert.equal(Boolean(view.queryByText('One')), showOptionsOnScreen);
  assert.equal(Boolean(view.queryByText('Один')), showOptionsOnScreen);
  assert.equal(view.queryByText(/correct/i), null);
  assert.equal(view.queryByRole('button'), null);
});

test('closed Round Intro hides Start Round', async () => {
  socket();
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ROUND_INTRO', closedAt: 'now' }, players: [player], game: introGame });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText('Room closed')));
  assert.equal(view.queryByRole('button', { name: 'Start Round' }), null);
});

for (const language of ['ru', 'en']) test(`Player ${language} receives Question and reloads get-ready without controls`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ROUND_INTRO';
  globalThis.fetch = async () => Response.json({ room: { ...room, state: phase }, player: { ...player, language }, active: true });
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Раунд начинается…' : 'Round is starting…')));
  phase = 'QUESTION';
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Приготовьтесь к вопросу' : 'Get ready for the question'));
  assert.equal(view.queryByRole('button'), null);
  view.unmount();
  view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Приготовьтесь к вопросу' : 'Get ready for the question')));
});

const timerStart = Date.parse('2026-09-26T12:00:00.000Z');
const answerTimer = { serverNow: new Date(timerStart).toISOString(), deadlineAt: new Date(timerStart + 12000).toISOString(), durationSeconds: 12, remainingMs: 12000, expired: false };

test('Host starts Question without confirmation and countdown expires without reveal or restart', async (t) => {
  socket();
  let started = false;
  let elapsed = 0;
  mock.method(performance, 'now', () => elapsed);
  mock.method(window, 'confirm', () => { throw new Error('No confirmation for Start Question'); });
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), '/api/rooms/room/start-question');
      started = true;
      return Response.json({ ...room, state: 'ANSWERING' });
    }
    return Response.json({ room: { ...room, state: started ? 'ANSWERING' : 'QUESTION' }, game: { ...questionGame, state: started ? 'ANSWERING' : 'QUESTION', ...(started ? { timer: answerTimer } : {}) } });
  };
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Start Question' })));
  t.mock.timers.enable({ apis: ['setInterval'] });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Start Question' })); });
  assert.equal(view.getByRole('timer').textContent, '12');
  assert.ok(view.getByText('Correct answer'));
  assert.equal(view.queryByRole('button', { name: 'Start Question' }), null);
  elapsed = 12000;
  await act(async () => { t.mock.timers.tick(12000); });
  assert.equal(view.getByRole('timer').textContent, '0');
  assert.ok(view.getByText(/Time is up/));
  assert.equal(view.queryByRole('button', { name: /Reveal|Restart|Pause|Next/ }), null);
});

for (const showOptionsOnScreen of [false, true]) test(`Screen Answering resyncs and reloads the same deadline with options ${showOptionsOnScreen}`, async () => {
  const live = socket();
  const { points, answerTimeSeconds, options, ...question } = questionGame;
  let timer = answerTimer;
  const state = () => ({ room: { ...room, state: 'ANSWERING' }, game: { ...question, state: 'ANSWERING', timer, showOptionsOnScreen,
    ...(showOptionsOnScreen ? { options: options.map(({ textRu, textEn }) => ({ textRu, textEn })) } : {}) } });
  globalThis.fetch = async () => Response.json(state());
  let view = show('/screen/room');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '12'));
  assert.equal(Boolean(view.queryByText('One')), showOptionsOnScreen);
  assert.equal(view.queryByText(/Correct answer/), null);
  timer = { ...answerTimer, serverNow: new Date(timerStart + 7000).toISOString(), remainingMs: 5000 };
  await act(async () => { live.emit('lobby:state', state()); });
  assert.equal(view.getByRole('timer').textContent, '5');
  view.unmount();
  view = show('/screen/room');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '5'));
  timer = { ...timer, serverNow: answerTimer.deadlineAt, remainingMs: 0, expired: true };
  await act(async () => { live.emit('lobby:state', state()); });
  assert.equal(view.getByRole('timer').textContent, '0');
  assert.ok(view.getByText(/Время вышло.*Time is up/));
  await act(async () => { live.emit('lobby:state', { ...state(), room: { ...room, state: 'ANSWERING', closedAt: 'now' } }); });
  assert.ok(view.getByText(/Room closed/));
  assert.equal(view.queryByRole('timer'), null);
});

for (const language of ['ru', 'en']) test(`Player ${language} fetches Answering content with its token and renders noninteractive choices`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let answering = false;
  let timer = answerTimer;
  const text = language === 'ru' ? 'Личный вопрос' : 'Personal question';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/rooms/room/reconnect');
    assert.deepEqual(JSON.parse(String(init?.body)), { token: 'secret' });
    return Response.json({ room: { ...room, state: answering ? 'ANSWERING' : 'QUESTION' }, player: { ...player, language }, active: true,
      game: answering ? { state: 'ANSWERING', questionId: 'q', text, options: [{ id: 'a', text: language === 'ru' ? 'Да' : 'Yes' }], timer } : null });
  };
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Приготовьтесь к вопросу' : 'Get ready for the question')));
  answering = true;
  live.on('lobby:subscribe', input => assert.deepEqual(input, { roomId: 'room', audience: 'player' }));
  await act(async () => { live.emit('connect'); live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' } }); });
  await waitFor(() => assert.ok(view.getByText(text)));
  assert.equal(view.getByRole('timer').textContent, '12');
  assert.ok(view.getByText(language === 'ru' ? 'Да' : 'Yes'));
  assert.equal(view.queryByRole('button'), null);
  assert.equal(view.queryByRole('radio'), null);
  assert.doesNotMatch(view.container.innerHTML, /isCorrect|Correct answer|Personal question.*Личный вопрос/);
  view.unmount();
  timer = { ...answerTimer, serverNow: answerTimer.deadlineAt, remainingMs: 0, expired: true };
  view = show('/play/ABCDE');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '0'));
  assert.ok(view.getByText(language === 'ru' ? 'Время вышло' : 'Time is up'));
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING', closedAt: 'now' } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
  assert.equal(view.queryByText(text), null);
});
