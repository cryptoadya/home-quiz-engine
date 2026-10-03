import './test-dom';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, mock, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { App } from './App';
import { lobbyTransport } from './lobby';

const originalFetch = globalThis.fetch;
const proto = window.HTMLMediaElement.prototype;
const originalPlay = proto.play, originalPause = proto.pause;
const originalReady = Object.getOwnPropertyDescriptor(proto, 'readyState')!;
const originalDuration = Object.getOwnPropertyDescriptor(proto, 'duration')!;
afterEach(() => {
  cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch;
  proto.play = originalPlay; proto.pause = originalPause;
  Object.defineProperty(proto, 'readyState', originalReady);
  Object.defineProperty(proto, 'duration', originalDuration);
});

const room = (state: string) => ({ id: 'delivery-room', code: 'ABCDE', quizTitle: 'Media', state, closedAt: null });
const question = (revision = 1, mediaId = 'a', state = 'QUESTION') => ({
  room: room(state), game: { state, questionId: 'q', roundNumber: 1, questionNumber: 1, questionCount: 1,
    textRu: '', textEn: '', preTimer: { mediaId, number: mediaId === 'a' ? 1 : 2, total: 2 },
    media: ['a', 'b'].map(id => ({ mediaId: id, name: id, kind: 'audio', mediaUrl: `/${id}`,
      playback: { playing: id === mediaId, positionSeconds: 0, serverNow: 0, revision: id === mediaId ? revision : 0 } })) } });
const answering = () => ({ room: room('ANSWERING'), game: { ...question().game, state: 'ANSWERING', preTimer: undefined,
  media: question().game.media.map(item => ({ ...item, playback: { ...item.playback, playing: false, revision: 2 } })) } });

function setup(autoplay = true) {
  let plays = 0;
  const played: string[] = [];
  proto.play = function () { plays++; played.push(this.getAttribute('src') ?? ''); return autoplay ? Promise.resolve() : Promise.reject(new Error('blocked')); };
  proto.pause = function () {};
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => 5 });
  const live = Object.assign(new EventEmitter(), { connected: false, connect() {}, disconnect() { this.connected = false; } });
  mock.method(lobbyTransport, 'connect', () => live as unknown as Socket);
  let snapshot: any = question();
  globalThis.fetch = async () => Response.json(snapshot);
  const subscribe = () => live.on('lobby:subscribe', () => live.emit('lobby:state', snapshot));
  subscribe();
  const show = () => render(createElement(MemoryRouter, { initialEntries: ['/screen/delivery-room'] }, createElement(App)));
  const connect = async () => { live.connected = true; await act(async () => { live.emit('connect'); }); };
  const disconnect = async () => { live.connected = false; await act(async () => { live.emit('disconnect'); }); };
  const end = async (view: ReturnType<typeof show>) => {
    await waitFor(() => assert.ok(view.container.querySelector('audio')));
    fireEvent.loadedMetadata(view.container.querySelector('audio')!);
    await waitFor(() => assert.ok(plays > 0));
    await act(async () => { fireEvent.ended(view.container.querySelector('audio')!); });
  };
  return { live, show, connect, disconnect, end, subscribe, played, setSnapshot: (next: any) => { snapshot = next; } };
}

test('Screen completion while disconnected survives remount and advances after reconnect', async () => {
  const h = setup(); const deliveries: any[] = [];
  const receive = () => h.live.on('media:ended', (event, ack) => { deliveries.push(event); ack({ accepted: true }); h.setSnapshot(question(1, 'b')); queueMicrotask(() => h.live.emit('lobby:state', question(1, 'b'))); });
  receive();
  let view = h.show();
  await h.end(view);
  assert.equal(deliveries.length, 0);
  view.unmount(); view = h.show(); h.subscribe(); receive();
  await h.connect();
  await waitFor(() => assert.equal(deliveries.length, 1));
  assert.deepEqual(deliveries[0], { roomId: 'delivery-room', questionId: 'q', mediaId: 'a', revision: 1, duration: 5 });
  await waitFor(() => assert.ok(h.played.includes('/b')), { timeout: 1000 });
  assert.equal(view.queryByText(/Before timer/), null);
});

test('lost ACK retries the identical completion and only one delivery advances the lifecycle', async () => {
  const h = setup(); const deliveries: any[] = []; let advancements = 0;
  h.live.on('media:ended', (event, ack) => {
    deliveries.push(event);
    if (deliveries.length === 1) return; // Packet was sent but lost before server processing.
    advancements++; ack({ accepted: true }); h.setSnapshot(answering()); h.live.emit('lobby:state', answering());
  });
  const view = h.show(); await h.connect(); await h.end(view);
  assert.equal(deliveries.length, 1);
  await h.disconnect(); await h.connect();
  await waitFor(() => assert.equal(deliveries.length, 2));
  assert.deepEqual(deliveries[1], deliveries[0]);
  assert.equal(advancements, 1);
});

test('Host restart and newer pre-timer media snapshots discard stale pending completion', async () => {
  for (const next of [question(2), question(1, 'b')]) {
    const h = setup(); const deliveries: any[] = [];
    h.live.on('media:ended', event => deliveries.push(event));
    const view = h.show(); await h.end(view);
    h.setSnapshot(next); await h.connect();
    assert.equal(deliveries.length, 0);
    view.unmount();
  }
});

test('reconnect after server processed an event but lost its ACK clears it from the ANSWERING snapshot', async () => {
  const h = setup(); const deliveries: any[] = [];
  h.live.on('media:ended', event => deliveries.push(event));
  const view = h.show(); await h.connect(); await h.end(view);
  assert.equal(deliveries.length, 1);
  await h.disconnect(); h.setSnapshot(answering()); await h.connect();
  assert.equal(deliveries.length, 1);
});

for (const kind of ['audio', 'video']) for (const reason of ['manual', 'player_disconnect']) for (const endedBeforePause of [false, true]) {
  test(`${kind} EOF completion survives ${reason} pause with report-before-pause=${endedBeforePause}`, async () => {
    const h = setup(); const deliveries: any[] = []; let accept = false; let advancements = 0;
    const initial = question();
    initial.game.media[0].kind = kind;
    h.setSnapshot(initial);
    const receive = () => h.live.on('media:ended', (event, ack) => {
      deliveries.push(event);
      if (!accept) { ack({ accepted: false }); return; }
      advancements++; ack({ accepted: true }); h.setSnapshot(answering());
      queueMicrotask(() => h.live.emit('lobby:state', answering()));
    });
    receive();
    const view = h.show(); await h.connect();
    await act(async () => {}); // Flush the successful local play promise.
    const element = view.container.querySelector('audio,video')!;
    if (endedBeforePause) await act(async () => { fireEvent.ended(element); });
    const pausedContent = { ...initial.game, media: initial.game.media.map(item => ({ ...item,
      playback: { ...item.playback, playing: false, positionSeconds: 5.1 } })) };
    const paused = { room: room('PAUSED'), game: { state: 'PAUSED', pausedFromState: 'QUESTION', reason, remainingMs: null, content: pausedContent } };
    await act(async () => { h.live.emit('lobby:state', paused); });
    const beforeResume = deliveries.length;
    fireEvent.ended(element);
    assert.equal(deliveries.length, beforeResume, 'paused Screen does not report completion');
    if (endedBeforePause) {
      view.unmount(); h.setSnapshot(paused); h.show(); h.subscribe(); receive();
      await h.connect(); // Pending local completion also survives a paused remount.
      assert.equal(deliveries.length, beforeResume);
    }
    accept = true;
    const resumed = { ...initial, game: { ...initial.game, media: initial.game.media.map(item => ({ ...item,
      playback: { ...item.playback, positionSeconds: 5.1 } })) } };
    await act(async () => { h.live.emit('lobby:state', resumed); });
    assert.equal(advancements, 1);
    assert.deepEqual(deliveries.at(-1), { roomId: 'delivery-room', questionId: 'q', mediaId: 'a', revision: 1, duration: 5 });
    assert.equal(deliveries.length, beforeResume + 1);
    cleanup();
  });
}

test('restart after game pause discards the old local completion attempt', async () => {
  const h = setup(); const deliveries: any[] = [];
  h.live.on('media:ended', event => deliveries.push(event));
  const view = h.show(); await h.end(view);
  const paused = { room: room('PAUSED'), game: { state: 'PAUSED', pausedFromState: 'QUESTION', remainingMs: null,
    content: { ...question().game, media: question().game.media.map(item => ({ ...item, playback: { ...item.playback, playing: false, positionSeconds: 5.1 } })) } } };
  h.setSnapshot(paused); await h.connect();
  assert.equal(deliveries.length, 0);
  h.setSnapshot(question(2));
  await act(async () => { h.live.emit('lobby:state', question(2)); });
  assert.equal(deliveries.length, 0, 'old pre-pause report cannot finish Host Restart');
  await h.end(view);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].revision, 2);
});

test('blocked autoplay cannot complete across game Pause/Resume at projected EOF', async () => {
  const h = setup(false); const deliveries: any[] = [];
  h.live.on('media:ended', event => deliveries.push(event));
  const view = h.show(); await h.connect();
  await waitFor(() => assert.ok(view.getByRole('alert')));
  const pausedContent = { ...question().game, media: question().game.media.map(item => ({ ...item,
    playback: { ...item.playback, playing: false, positionSeconds: 5.1 } })) };
  await act(async () => { h.live.emit('lobby:state', { room: room('PAUSED'), game: { state: 'PAUSED', pausedFromState: 'QUESTION', remainingMs: null, content: pausedContent } }); });
  await act(async () => { h.live.emit('lobby:state', { ...question(), game: { ...question().game,
    media: question().game.media.map(item => ({ ...item, playback: { ...item.playback, positionSeconds: 5.1 } })) } }); });
  fireEvent.ended(view.container.querySelector('audio')!);
  assert.equal(deliveries.length, 0);
});

test('connected natural ending sends once, and blocked autoplay never sends', async () => {
  const h = setup(); const deliveries: any[] = [];
  h.live.on('media:ended', (event, ack) => { deliveries.push(event); ack({ accepted: true }); });
  const view = h.show(); await h.connect(); await h.end(view);
  fireEvent.ended(view.container.querySelector('audio')!);
  assert.equal(deliveries.length, 1);
  view.unmount();
  const blocked = setup(false); const blockedDeliveries: any[] = [];
  blocked.live.on('media:ended', event => blockedDeliveries.push(event));
  const blockedView = blocked.show(); await blocked.connect();
  await waitFor(() => assert.ok(blockedView.getByRole('alert')));
  fireEvent.ended(blockedView.container.querySelector('audio')!);
  assert.equal(blockedDeliveries.length, 0);
});

for (const [name, message] of [['NotAllowedError', /blocked.*Tap Play on this Screen/], ['NotSupportedError', /format cannot be played/], ['AbortError', /Playback failed/]] as const) {
  test(`${name} has an actionable Screen message and blocked playback retries locally`, async () => {
    const h = setup(); const deliveries: unknown[] = [];
    h.live.on('media:ended', (event, ack) => { deliveries.push(event); ack({ accepted: true }); });
    let blocked = true;
    proto.play = () => blocked ? Promise.reject(new DOMException('raw exception', name)) : Promise.resolve();
    const view = h.show(); await h.connect();
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, message));
    assert.doesNotMatch(view.getByRole('alert').textContent!, /raw exception/);
    if (name === 'NotSupportedError') { assert.equal(view.queryByRole('button', { name: /Play media/ }), null); return; }
    blocked = false;
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /Play media/ })); });
    assert.equal(view.queryByRole('alert'), null);
    await act(async () => { fireEvent.ended(view.container.querySelector('audio')!); });
    assert.equal(deliveries.length, 1);
  });
}

for (const kind of ['audio', 'video']) test(`late ${kind} Screen at EOF requires local replay before mandatory completion`, async () => {
  const h = setup(); const deliveries: unknown[] = [];
  const initial = question(); initial.game.media[0].kind = kind;
  initial.game.media[0].playback.positionSeconds = 6;
  h.setSnapshot(initial);
  h.live.on('media:ended', (event, ack) => { deliveries.push(event); ack({ accepted: true }); });
  const view = h.show(); await h.connect();
  await waitFor(() => assert.ok(view.getByRole('button', { name: /Replay media/ })));
  const element = view.container.querySelector<HTMLMediaElement>('audio,video')!;
  fireEvent.ended(element);
  assert.equal(deliveries.length, 0, 'server elapsed time is insufficient');
  await act(async () => { fireEvent.click(view.getByRole('button', { name: /Replay media/ })); });
  assert.equal(element.currentTime, 0);
  // A same-revision resync must not seek the local replay back to EOF.
  await act(async () => { h.live.emit('lobby:state', initial); });
  assert.equal(element.currentTime, 0);
  assert.equal(deliveries.length, 0);
  await act(async () => { fireEvent.ended(element); });
  assert.equal(deliveries.length, 1);
});

for (const code of [2, 3, 4]) test(`media element error ${code} is mapped without raw exceptions`, async () => {
  const h = setup(); const view = h.show(); await h.connect();
  const element = view.container.querySelector('audio')!;
  Object.defineProperty(element, 'error', { configurable: true, value: { code, message: 'raw exception' } });
  fireEvent.error(element);
  assert.match(view.getByRole('alert').textContent!, code === 2 ? /Playback failed/ : /format cannot be played/);
  assert.doesNotMatch(view.getByRole('alert').textContent!, /raw exception/);
});
