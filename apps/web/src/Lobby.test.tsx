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
afterEach(() => { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); dom.reconfigure({ url: 'http://localhost' }); });
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

test('Screen renders count, one language-neutral Player QR, LAN origin and live closure', async () => {
  dom.reconfigure({ url: 'http://192.168.1.50:5173/screen/room' });
  try {
    const live = socket();
    globalThis.fetch = async () => Response.json({ room, players: [player] });
    const view = show('/screen/room');
    await waitFor(() => assert.ok(view.getByText('ABCDE')));
    assert.ok(view.getByText(/Players: 1/));
    assert.equal(view.queryByRole('alert'), null);
    const link = view.getByRole('link', { name: 'Players / Игроки' }) as HTMLAnchorElement;
    assert.equal(link.href, 'http://192.168.1.50:5173/play/ABCDE');
    assert.equal(view.container.querySelectorAll('.join-codes svg').length, 1);
    await act(async () => { live.emit('lobby:state', { room: { ...room, closedAt: 'now' }, players: [player] }); });
    assert.ok(view.getByText(/Room closed/));
    assert.equal(view.queryByRole('link', { name: 'Players / Игроки' }), null);
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
  live.on('lobby:subscribe', input => assert.deepEqual(input, { roomId: 'room', audience: 'player', token: 'secret' }));
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

for (const hostname of ['party.localhost', 'localhost.', '127.0.0.2', '0.0.0.0', '[::1]', '[::]', '[::ffff:127.0.0.1]']) {
  test(`Screen withholds QR links for guest-unreachable origin ${hostname}`, async () => {
    dom.reconfigure({ url: `http://${hostname}:5173/screen/room` });
    try {
      socket();
      globalThis.fetch = async () => Response.json({ room, players: [] });
      const view = show('/screen/room');
      await waitFor(() => assert.ok(view.getByText('ABCDE')));
      assert.match(view.getByRole('alert').textContent!, /LAN address/);
      assert.ok(view.getByRole('alert').classList.contains('screen-join-warning'));
      assert.equal(view.container.querySelector('.join-codes svg'), null);
    } finally { dom.reconfigure({ url: 'http://localhost' }); }
  });
}

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
  dom.reconfigure({ url: 'http://192.168.1.50:5173' });
  const live = socket();
  globalThis.fetch = async () => Response.json({ room, players: [player] });
  let view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByRole('link', { name: 'Players / Игроки' })));
  const started = { room: { ...room, state: 'ROUND_INTRO', quizTitle: 'Frozen title' }, players: [player], game: introGame };
  await act(async () => { live.emit('lobby:state', started); });
  assert.ok(view.getByText('Frozen round'));
  assert.ok(view.getByText('Замороженный раунд'));
  assert.equal(view.queryByRole('link', { name: 'Players / Игроки' }), null);
  assert.equal(view.queryByText(/scan a QR/), null);
  assert.equal(view.container.querySelector('.join-codes svg'), null);
  view.unmount();
  globalThis.fetch = async () => Response.json(started);
  view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('Frozen round')));
  assert.ok(view.getByText('Frozen title'));
  assert.equal(view.container.querySelector('.join-codes svg'), null);
});

for (const language of ['ru', 'en']) test(`Player ${language} leaves waiting on Start and restores starting state`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  globalThis.fetch = async () => Response.json({ room, player: { ...player, language }, active: true });
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(language === 'ru' ? 'Ожидайте ведущего…' : 'Waiting for the host…')));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
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

for (const showOptionsOnScreen of [false, true]) test(`Screen preparation hides content until public start, options ${showOptionsOnScreen}`, async () => {
  const live = socket();
  const { points, answerTimeSeconds, options, ...question } = questionGame;
  const game = { ...question, showOptionsOnScreen, options: options.map(({ textRu, textEn }) => ({ textRu, textEn })),
    explanationRu: 'Private explanation', leftItems: [{ id: 'left', kind: 'text', textRu: 'Скрытая пара', textEn: 'Private matching' }] };
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'QUESTION' }, game });
  const view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText('Следующий вопрос готов / Next question is ready')));
  for (const text of ['First question', 'Первый вопрос', 'One', 'Один', 'Private explanation', 'Private matching']) assert.equal(view.queryByText(text), null);
  // Required media publicly starts while the room remains in QUESTION.
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'QUESTION' }, game: { ...game, preTimer: { mediaId: 'audio', number: 1, total: 1 } } }); });
  assert.ok(view.getByText('First question'));
  assert.ok(view.getByText('Первый вопрос'));
  assert.equal(Boolean(view.queryByText('One')), false);
  assert.equal(Boolean(view.queryByText('Один')), false);
  assert.equal(Boolean(view.queryByText(/Private matching/)), false);
  assert.equal(view.queryByText(/correct/i), null);
  assert.equal(view.queryByRole('button'), null);
  assert.equal(view.queryByText('Private explanation'), null);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' }, game: { ...game, state: 'ANSWERING' } }); });
  assert.ok(view.getByText('First question'));
  await act(async () => { live.emit('connect'); });
  assert.equal(view.queryByText('Connected'), null);
  assert.equal(view.container.querySelector('.connection-chip'), null);
  assert.equal(Boolean(view.queryByText('One')), false);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWER_REVEAL' }, game: { ...game, state: 'ANSWER_REVEAL', options } }); });
  assert.equal(view.queryByText('One'), null);
  assert.ok(view.getByText('Two'));
  assert.ok(view.getByText('Private explanation'));
});

test('Host primary action precedes question details and a full roster without changing Kick', async () => {
  socket();
  const players = Array.from({ length: 30 }, (_, i) => ({ ...player, id: `p${i}`, name: `Guest ${i}`, present: i !== 0 }));
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'QUESTION' }, game: questionGame, players });
  const view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Start Question' })));
  const action = view.getByRole('button', { name: 'Start Question' });
  assert.ok(action.classList.contains('host-primary-action'));
  assert.equal(view.getByRole('region', { name: 'Game controls' }).querySelector('button'), action);
  const roster = view.container.querySelector('.host-roster')!;
  assert.ok(action.compareDocumentPosition(roster) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(action.compareDocumentPosition(view.getByText('First question')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(view.getAllByRole('button', { name: /^Kick Guest/ }).length, 30);
  assert.ok(view.getByText(/Guest 0.*Disconnected/));
  let confirmed = '';
  mock.method(window, 'confirm', (message: string) => { confirmed = message; return false; });
  fireEvent.click(view.getByRole('button', { name: 'Kick Guest 0' }));
  assert.match(confirmed, /Kick Guest 0.*cannot reconnect/);
  assert.equal(roster.querySelectorAll('li').length, 30);
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
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  phase = 'QUESTION';
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Приготовьтесь к вопросу' : 'Get ready for the question'));
  assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), [language === 'ru' ? 'Настройки' : 'Settings']);
  assert.equal(view.queryByLabelText('Player language'), null);
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
  assert.equal(view.queryByRole('button', { name: /Reveal|Restart|Next/ }), null);
  assert.ok(view.getByRole('button', { name: 'Pause' }));
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
  assert.equal(Boolean(view.queryByText('One')), false);
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

for (const language of ['ru', 'en']) test(`Player ${language} fetches Answering content with its token and renders selectable choices`, async () => {
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
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  answering = true;
  live.on('lobby:subscribe', input => assert.deepEqual(input, { roomId: 'room', audience: 'player', token: 'secret' }));
  await act(async () => { live.emit('connect'); live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' } }); });
  await waitFor(() => assert.ok(view.getByText(text)));
  assert.equal(view.getByRole('timer').textContent, '12');
  assert.ok(view.getByText(language === 'ru' ? 'Да' : 'Yes'));
  assert.equal((view.getByRole('button', { name: language === 'ru' ? 'Отправить' : 'Submit' }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByRole('radio'));
  assert.doesNotMatch(view.container.innerHTML, /isCorrect|Correct answer|Personal question.*Личный вопрос/);
  view.unmount();
  timer = { ...answerTimer, serverNow: answerTimer.deadlineAt, remainingMs: 0, expired: true };
  view = show('/play/ABCDE');
  await waitFor(() => assert.equal(view.getByRole('timer').textContent, '0'));
  assert.ok(view.getByText(language === 'ru' ? 'Время вышло' : 'Time is up'));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING', closedAt: 'now' } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
  assert.equal(view.queryByText(text), null);
});

for (const outcome of ['accepted', 'timeout', 'local-timeout']) test(`Player draft selection and ${outcome}`, async () => {
  socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let elapsed = 0;
  mock.method(performance, 'now', () => elapsed);
  let submitted = false;
  let calls = 0;
  const game = () => ({ state: 'ANSWERING', questionId: 'q', text: 'Choose one', options: [{ id: 'a', text: 'Apple' }, { id: 'b', text: 'Berry' }], timer: answerTimer,
    submission: submitted ? { submitted: true, optionId: 'b' } : { submitted: false } });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/answers')) {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { token: 'secret', questionId: 'q', optionId: 'b' });
      if (outcome === 'timeout') return Response.json({ code: 'DEADLINE_REACHED', error: 'Time is up.' }, { status: 409 });
      submitted = true;
      return Response.json({ submitted: true, optionId: 'b' });
    }
    return Response.json({ room: { ...room, state: 'ANSWERING' }, player, active: true, game: game() });
  };
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Choose one')));
  const submit = view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
  assert.equal(submit.disabled, true);
  fireEvent.click(view.getByRole('radio', { name: 'Apple' }));
  assert.equal(submit.disabled, false);
  fireEvent.click(view.getByRole('radio', { name: 'Berry' }));
  assert.equal((view.getByRole('radio', { name: 'Apple' }) as HTMLInputElement).checked, false);
  assert.equal((view.getByRole('radio', { name: 'Berry' }) as HTMLInputElement).checked, true);
  assert.equal(calls, 0);
  if (outcome === 'local-timeout') {
    // Re-render using the real interval with a deterministic monotonic clock.
    elapsed = 12000;
    await waitFor(() => assert.equal(submit.disabled, true));
    assert.equal(calls, 0);
  } else {
    await act(async () => { fireEvent.click(submit); });
    assert.equal(submit.disabled, true);
    assert.equal(calls, 1);
    assert.ok(view.getByText(outcome === 'accepted' ? 'Answer submitted' : 'Time is up'));
    assert.equal((view.getByRole('radio', { name: 'Apple' }) as HTMLInputElement).disabled, true);
  }
  assert.doesNotMatch(view.container.innerHTML, /isCorrect|Correct answer|points|rank/);
  if (outcome === 'accepted') {
    view.unmount(); view = show('/play/ABCDE');
    await waitFor(() => assert.ok(view.getByText('Answer submitted')));
    assert.equal((view.getByRole('radio', { name: 'Berry' }) as HTMLInputElement).checked, true);
    assert.equal((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled, true);
  }
});

for (const audience of ['host', 'screen']) test(`${audience} updates aggregate answer counts live`, async () => {
  const live = socket();
  const state = (answered: number) => ({ room: { ...room, state: 'ANSWERING' }, game: { ...questionGame, state: 'ANSWERING', timer: answerTimer, answers: { answered, expected: 2 } } });
  globalThis.fetch = async () => Response.json(state(0));
  const view = show(`/${audience}/room`);
  await waitFor(() => assert.ok(view.getByText(/Answered: 0 \/ 2/)));
  await act(async () => { live.emit('lobby:state', state(1)); });
  assert.ok(view.getByText(/Answered: 1 \/ 2/));
  await act(async () => { live.emit('lobby:state', state(2)); });
  assert.ok(view.getByText(/Answered: 2 \/ 2/));
  assert.equal(view.queryByRole('button', { name: /Reveal|Next/ }), null);
});

test('lost Submit response can retry and recover the original choice; stale refresh cannot unlock it', async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  const game = { state: 'ANSWERING', questionId: 'q', text: 'Pick', options: [{ id: 'a', text: 'Apple' }, { id: 'b', text: 'Berry' }], timer: answerTimer, submission: { submitted: false } };
  let submissions = 0;
  let reconnects = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/answers')) {
      if (++submissions === 1) throw new Error('Response lost');
      return Response.json({ submitted: true, optionId: 'a' });
    }
    reconnects++;
    return Response.json({ room: { ...room, state: 'ANSWERING' }, player, active: true, game });
  };
  const view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Pick')));
  fireEvent.click(view.getByRole('radio', { name: 'Apple' }));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Submit' })); });
  assert.ok(view.getByRole('alert'));
  fireEvent.click(view.getByRole('radio', { name: 'Berry' }));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Submit' })); });
  assert.ok(view.getByText('Answer submitted'));
  assert.equal((view.getByRole('radio', { name: 'Apple' }) as HTMLInputElement).checked, true);
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWERING' } }); });
  await waitFor(() => assert.equal(reconnects, 2));
  assert.ok(view.getByText('Answer submitted'));
  assert.equal((view.getByRole('radio', { name: 'Berry' }) as HTMLInputElement).disabled, true);
});

for (const audience of ['host', 'screen']) test(`${audience} Reveal shows correct options even when hidden during question; closure overrides`, async () => {
  const live = socket();
  const reveal = { room: { ...room, state: 'ANSWER_REVEAL' }, game: { ...questionGame, state: 'ANSWER_REVEAL', showOptionsOnScreen: false,
    answers: { answered: 2, expected: 2 }, statistics: { correct: 1, wrong: 1, unanswered: 0 },
    options: [{ textRu: 'Верный', textEn: 'Right', isCorrect: true }, { textRu: 'Неверный', textEn: 'Wrong', isCorrect: false }] } };
  globalThis.fetch = async () => Response.json({ room: { ...room, state: 'ANSWERING' }, game: { ...questionGame, state: 'ANSWERING', timer: answerTimer } });
  const view = show(`/${audience}/room`);
  await waitFor(() => assert.ok(view.getByRole('timer')));
  await act(async () => { live.emit('lobby:state', reveal); });
  assert.ok(view.getByText(/Correct answer/));
  assert.ok(view.getByText('Right'));
  assert.equal(Boolean(view.queryByText('Wrong')), audience === 'host');
  assert.ok(view.getByText(/Answered: 2 \/ 2/));
  assert.equal(view.queryByRole('timer'), null);
  assert.equal(view.queryByRole('button', { name: /Next|Reveal/ }), null);
  await act(async () => { live.emit('lobby:state', { ...reveal, room: { ...reveal.room, closedAt: 'now' } }); });
  assert.equal(view.queryByText('Right'), null);
  assert.ok(view.getByText(/Room closed/));
});

for (const [outcome, language, label, points] of [
  ['correct', 'en', 'Correct! +3', 3], ['wrong', 'en', 'Incorrect', 0], ['unanswered', 'en', 'No answer', 0],
  ['correct', 'ru', 'Верно! +3', 3], ['wrong', 'ru', 'Неверно', 0], ['unanswered', 'ru', 'Нет ответа', 0],
] as const) test(`Player ${language} ${outcome} realtime Reveal and refresh restore only personal result`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let revealed = false;
  globalThis.fetch = async () => Response.json({ room: { ...room, state: revealed ? 'ANSWER_REVEAL' : 'ANSWERING' }, player: { ...player, language }, active: true,
    game: { state: revealed ? 'ANSWER_REVEAL' : 'ANSWERING', questionId: 'q', text: 'Pick',
      options: [{ id: 'a', text: 'Apple' }, { id: 'b', text: 'Berry' }], timer: answerTimer,
      submission: outcome === 'unanswered' ? { submitted: false } : { submitted: true, optionId: outcome === 'correct' ? 'a' : 'b' },
      ...(revealed ? { correctOptionId: 'a', result: { outcome, points } } : {}) } });
  let view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText('Pick')));
  // The initial HTTP question can paint before the Player socket effect subscribes.
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  revealed = true;
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWER_REVEAL' } }); });
  await waitFor(() => assert.ok(view.getByText(label)));
  assert.ok(view.getByText(language === 'ru' ? `Очки: ${points}` : `Points: ${points}`));
  assert.ok(view.getByText(language === 'ru' ? 'Верный ответ: Apple' : 'Correct answer: Apple'));
  assert.equal(view.queryByRole('radio'), null);
  assert.equal(view.queryByRole('button', { name: /Submit|Отправить/ }), null);
  assert.doesNotMatch(view.container.innerHTML, /rank|leaderboard/i);
  view.unmount(); view = show('/play/ABCDE');
  await waitFor(() => assert.ok(view.getByText(label)));
  await waitFor(() => assert.equal(live.listenerCount('lobby:state'), 1));
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: 'ANSWER_REVEAL', closedAt: 'now' } }); });
  assert.equal(view.queryByText(label), null);
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
});

const standingRows = [
  { playerId: 'a', displayName: 'Alice', totalPoints: 10, rank: 1 },
  { playerId: 'b', displayName: 'Bob', totalPoints: 10, rank: 1 },
  { playerId: 'c', displayName: 'Carol', totalPoints: 8, rank: 3 },
];
const boundary = (phase: string, nextAction: string | null, leaderboard = standingRows) => ({
  room: { ...room, state: phase },
  game: { state: phase, roundNumber: 1, questionCount: 2, titleRu: 'Раунд один', titleEn: 'Round one', nextAction,
    ...(phase === 'ROUND_END' ? {} : { leaderboard: phase === 'WINNER_SCREEN' ? leaderboard.filter(p => p.rank === 1) : leaderboard }) },
});

test('Host follows explicit Reveal, round, leaderboard and final commands, with reload at every boundary', async () => {
  socket();
  mock.method(window, 'confirm', () => { throw new Error('No confirmation for progression'); });
  let snapshot: unknown = { room: { ...room, state: 'ANSWER_REVEAL' }, game: { ...questionGame, state: 'ANSWER_REVEAL', questionNumber: 1, questionCount: 2, nextAction: 'next' } };
  const commands: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const command = String(url).split('/').at(-1)!;
      commands.push(command);
      if (command === 'next' && commands.length === 1) snapshot = { room: { ...room, state: 'QUESTION' }, game: { ...questionGame, state: 'QUESTION', questionNumber: 2, questionCount: 2 } };
      else if (command === 'next') snapshot = boundary('ROUND_END', 'show-leaderboard');
      else if (command === 'show-leaderboard') snapshot = boundary('LEADERBOARD', 'next-round');
      else if (command === 'next-round') snapshot = { room: { ...room, state: 'ROUND_INTRO' }, game: { state: 'ROUND_INTRO', roundNumber: 2, questionCount: 1, titleRu: 'Второй', titleEn: 'Second', descriptionRu: '', descriptionEn: '' } };
      else if (command === 'final-results') snapshot = boundary('FINAL_RESULTS', 'show-winner');
      else if (command === 'show-winner') snapshot = boundary('WINNER_SCREEN', null);
      else throw new Error(`Unexpected command: ${command}`);
    }
    return Response.json(snapshot);
  };
  let view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Next Question' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Next Question' })); });
  assert.ok(view.getByRole('button', { name: 'Start Question' }));
  assert.equal(view.queryByRole('timer'), null);
  view.unmount();
  snapshot = { room: { ...room, state: 'ANSWER_REVEAL' }, game: { ...questionGame, state: 'ANSWER_REVEAL', questionNumber: 2, questionCount: 2, nextAction: 'next' } };
  view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Next' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Next' })); });
  assert.ok(view.getByText('Раунд завершён / Round complete'));
  assert.ok(view.getByText('Round one'));
  for (const action of ['Show Leaderboard', 'Next Round']) {
    view.unmount(); view = show('/host/room');
    await waitFor(() => assert.ok(view.getByRole('button', { name: action })));
    if (action === 'Next Round') {
      const ranks = [...view.getByRole('table').querySelectorAll('tbody tr')].map(row => row.firstElementChild?.textContent);
      assert.deepEqual(ranks, ['1', '1', '3']);
      assert.ok(view.getByText('Alice')); assert.ok(view.getByText('Carol'));
    }
    await act(async () => { fireEvent.click(view.getByRole('button', { name: action })); });
  }
  assert.ok(view.getByText('Second'));
  assert.ok(view.getByRole('button', { name: 'Start Round' }));
  view.unmount();
  snapshot = boundary('ROUND_END', 'final-results');
  view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Final Results' })));
  assert.equal(view.queryByRole('button', { name: 'Show Leaderboard' }), null);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Final Results' })); });
  assert.ok(view.getByRole('table'));
  assert.ok(view.getByRole('button', { name: 'Show Winner' }));
  assert.equal(view.queryByText('Победители / Winners'), null);
  view.unmount(); view = show('/host/room');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Show Winner' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Show Winner' })); });
  view.unmount(); view = show('/host/room');
  await waitFor(() => assert.ok(view.getByText('Победители / Winners')));
  assert.ok(view.getByText('Alice')); assert.ok(view.getByText('Bob'));
  assert.equal(view.queryByRole('button', { name: /Next|Show|Start|Final/ }), null);
  assert.deepEqual(commands, ['next', 'next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner']);
});

for (const tied of [false, true]) test(`Screen live navigation and reload renders ${tied ? 'tied' : 'single'} winners and closure`, async () => {
  const live = socket();
  const standings = tied ? standingRows : [standingRows[0], { ...standingRows[1], rank: 2, totalPoints: 9 }];
  let snapshot: unknown = { room: { ...room, state: 'ANSWER_REVEAL' }, game: { ...questionGame, state: 'ANSWER_REVEAL' } };
  globalThis.fetch = async () => Response.json(snapshot);
  let view = show('/screen/room');
  await waitFor(() => assert.ok(view.getByText(/Correct answer/)));
  snapshot = { room: { ...room, state: 'QUESTION' }, game: { ...questionGame, state: 'QUESTION', questionNumber: 2, showOptionsOnScreen: true } };
  await act(async () => { live.emit('lobby:state', snapshot); });
  assert.ok(view.getByText(/Question 2/));
  assert.equal(view.queryByText(/Correct answer/), null);
  for (const phase of ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN']) {
    snapshot = boundary(phase, null, standings);
    await act(async () => { live.emit('lobby:state', snapshot); });
    view.unmount(); view = show('/screen/room');
    await waitFor(() => assert.ok(view.getByText(phase === 'ROUND_END' ? 'Round one' : 'Alice')));
    assert.equal(view.queryByRole('button'), null);
    if (phase === 'LEADERBOARD' || phase === 'FINAL_RESULTS') assert.ok(view.getByRole('table'));
    if (phase === 'WINNER_SCREEN') {
      assert.equal(Boolean(view.queryByText('Bob')), tied);
      assert.equal(view.queryByText('Carol'), null);
      assert.equal(view.queryByRole('table'), null);
    }
  }
  const closed = { ...boundary('WINNER_SCREEN', null, standings), room: { ...room, state: 'WINNER_SCREEN', closedAt: 'now' } };
  await act(async () => { live.emit('lobby:state', closed); });
  assert.equal(view.queryByText('Alice'), null);
  assert.ok(view.getByRole('status'));
});

for (const language of ['ru', 'en']) test(`Player ${language} new boundaries stay minimal across live navigation and reload`, async () => {
  const live = socket();
  dom.window.localStorage.setItem('quiz-player:ABCDE', JSON.stringify({ roomId: 'room', token: 'secret' }));
  let phase = 'ROUND_END';
  globalThis.fetch = async () => Response.json({ room: { ...room, state: phase }, player: { ...player, language }, active: true, game: null });
  let view!: ReturnType<typeof show>;
  await act(async () => { view = show('/play/ABCDE'); });
  const labels = language === 'ru' ? ['Раунд завершён', 'Смотрите на экран', 'Финальные результаты', 'Игра завершена'] : ['Round complete', 'Look at the screen', 'Final results', 'Game finished'];
  for (const [index, next] of ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].entries()) {
    phase = next;
    await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase } }); });
    await waitFor(() => assert.ok(view.getByText(labels[index])));
    view.unmount();
    await act(async () => { view = show('/play/ABCDE'); });
    await waitFor(() => assert.ok(view.getByText(labels[index])));
    assert.deepEqual(view.getAllByRole('button').map(button => button.textContent), [language === 'ru' ? 'Настройки' : 'Settings']);
    assert.equal(view.queryByLabelText('Player language'), null);
    assert.equal(view.queryByRole('table'), null);
    assert.doesNotMatch(view.container.innerHTML, /rank/i);
  }
  await act(async () => { live.emit('lobby:state', { room: { ...room, state: phase, closedAt: 'now' } }); });
  assert.ok(view.getByText(language === 'ru' ? 'Комната закрыта' : 'Room closed'));
  assert.equal(view.queryByText(labels[3]), null);
});

for (const surface of ['host', 'screen']) test(`${surface} labels test sessions throughout gameplay and after closure`, async () => {
  socket();
  const testRoom = { ...room, isTest: true, state: 'ROUND_INTRO' };
  globalThis.fetch = async () => Response.json({ room: testRoom, players: [] });
  const view = show(`/${surface}/room`);
  await waitFor(() => assert.ok(view.getByText('Тестовая игра / Test Game')));
  view.unmount();
  globalThis.fetch = async () => Response.json({ room: { ...testRoom, closedAt: 'now' }, players: [] });
  const closed = show(`/${surface}/room`);
  await waitFor(() => assert.ok(closed.getByText('Тестовая игра / Test Game')));
});
