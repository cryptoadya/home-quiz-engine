import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QuestionContent } from './GameContent';
import type { CurrentQuestion } from './lobby';
afterEach(cleanup);

test('Screen applies authoritative Play/Pause/Restart and reload position; Host controls never mount players', async () => {
  const proto = window.HTMLMediaElement.prototype;
  const oldPlay = proto.play, oldPause = proto.pause;
  const oldReady = Object.getOwnPropertyDescriptor(proto, 'readyState')!;
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 1 });
  const playing = new Set<HTMLMediaElement>();
  let maxPlaying = 0;
  proto.play = function () { playing.add(this); maxPlaying = Math.max(maxPlaying, playing.size); return Promise.resolve(); };
  proto.pause = function () { playing.delete(this); };
  const media = (id: string, kind: 'audio' | 'video', active: boolean, seconds = 0) => ({ mediaId: id, kind, name: id, mediaUrl: `/media/${id}`, playback: { playing: active, positionSeconds: seconds, revision: 1, serverNow: Date.now() } });
  const base: CurrentQuestion = { questionId: 'q', state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: 'Вопрос', textEn: 'Question', media: [media('audio', 'audio', true, 4), { mediaId: 'gif', name: 'GIF', mediaUrl: '/gif' }, media('video', 'video', false)] };
  try {
    const view = render(createElement(QuestionContent, { question: base }));
    const audio = view.container.querySelector('audio')!, video = view.container.querySelector('video')!;
    await waitFor(() => assert.ok(playing.has(audio)));
    assert.ok(audio.currentTime >= 4 && audio.currentTime < 5);
    assert.deepEqual([...view.container.querySelector('.question-media')!.children].map(node => node.tagName), ['AUDIO', 'IMG', 'VIDEO']);
    assert.equal(video.controls, false);
    view.rerender(createElement(QuestionContent, { question: { ...base, media: [media('audio', 'audio', false, 5), base.media![1], media('video', 'video', true, 0)] } }));
    await waitFor(() => assert.ok(playing.has(video)));
    assert.equal(playing.has(audio), false); assert.equal(maxPlaying, 1);
    view.rerender(createElement(QuestionContent, { question: { ...base, media: [media('audio', 'audio', true, 0), base.media![1], media('video', 'video', false, 2)] } }));
    await waitFor(() => assert.ok(playing.has(audio)));
    assert.ok(audio.currentTime < 1);
    view.unmount(); assert.equal(playing.size, 0);
    const commands: string[] = [];
    const host = render(createElement(QuestionContent, { question: base, host: true, onMediaControl: (id: string, action: string) => commands.push(`${id}:${action}`) }));
    assert.equal(host.container.querySelectorAll('audio,video').length, 0);
    for (const action of ['Play', 'Pause', 'Restart']) fireEvent.click(host.getByRole('button', { name: `${action} audio` }));
    assert.deepEqual(commands, ['audio:play', 'audio:pause', 'audio:restart']);
    assert.ok(host.getByAltText('GIF'));
  } finally { proto.play = oldPlay; proto.pause = oldPause; Object.defineProperty(proto, 'readyState', oldReady); }
});

test('Host posts stable media/question identities and restores server status after commands and reload', async () => {
  const { mock } = await import('node:test');
  const { EventEmitter } = await import('node:events');
  const { MemoryRouter } = await import('react-router-dom');
  const { App } = await import('./App');
  const { lobbyTransport } = await import('./lobby');
  const originalFetch = globalThis.fetch;
  const live = Object.assign(new EventEmitter(), { connect() {}, disconnect() {} });
  mock.method(lobbyTransport, 'connect', () => live as any);
  const item = { mediaId: 'stable', name: 'track', kind: 'audio' as const, mediaUrl: '/frozen', playback: { playing: false, positionSeconds: 3, revision: 1, serverNow: 0 } };
  const snapshot = { room: { id: 'room', code: 'ABCDE', quizTitle: 'Media', state: 'QUESTION', closedAt: null }, game: { questionId: 'question', state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: '', textEn: '', media: [item] } };
  const commands: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { questionId: 'question' });
      commands.push(String(url));
      item.playback.playing = !String(url).endsWith('/pause');
      item.playback.revision++;
      return Response.json(snapshot.room);
    }
    return Response.json(snapshot);
  };
  const show = () => render(createElement(MemoryRouter, { initialEntries: ['/host/room'] }, createElement(App)));
  try {
    let view = show();
    await waitFor(() => assert.ok(view.getByText('track — Paused')));
    for (const action of ['Play', 'Pause', 'Restart']) {
      fireEvent.click(view.getByRole('button', { name: `${action} track` }));
      await waitFor(() => assert.equal((view.getByRole('button', { name: `${action} track` }) as HTMLButtonElement).disabled, false));
      assert.ok(view.getByText(`track — ${action === 'Pause' ? 'Paused' : 'Playing'}`));
    }
    assert.deepEqual(commands, ['play', 'pause', 'restart'].map(action => `/api/rooms/room/media/stable/${action}`));
    view.unmount(); view = show();
    await waitFor(() => assert.ok(view.getByText('track — Playing')));
    assert.equal(view.container.querySelectorAll('audio,video').length, 0);
  } finally { cleanup(); mock.restoreAll(); globalThis.fetch = originalFetch; }
});


test('Screen restores an elapsed finished item without implicitly replaying it', async () => {
  const proto = window.HTMLMediaElement.prototype;
  const oldPlay = proto.play, oldPause = proto.pause;
  let plays = 0;
  proto.play = function () { plays++; return Promise.resolve(); };
  proto.pause = function () {};
  const question: CurrentQuestion = { state: 'QUESTION', roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: '', textEn: '', media: [{ mediaId: 'finished', name: 'finished', kind: 'audio', mediaUrl: '/audio', playback: { playing: true, positionSeconds: 10, serverNow: 0, revision: 1 } }] };
  try {
    const view = render(createElement(QuestionContent, { question }));
    const element = view.container.querySelector('audio')!;
    Object.defineProperty(element, 'duration', { get: () => 5 });
    Object.defineProperty(element, 'readyState', { get: () => 1 });
    fireEvent.loadedMetadata(element);
    assert.equal(plays, 0);
    assert.equal(element.currentTime, 0); // Finished audio needs no EOF seek.
  } finally { cleanup(); proto.play = oldPlay; proto.pause = oldPause; }
});

test('pre-timer Screen reports ended revision and elapsed reload; Host restricts controls to the current item', async () => {
  const proto = window.HTMLMediaElement.prototype;
  const oldPause = proto.pause; proto.pause = function () {};
  const completions: unknown[] = [];
  const question: CurrentQuestion = { state: 'QUESTION', questionId: 'q', preTimer: { mediaId: 'a', number: 1, total: 2 }, roundNumber: 1, questionNumber: 1, questionCount: 1, textRu: '', textEn: '', media: ['a', 'b'].map(mediaId => ({ mediaId, kind: 'audio', name: mediaId, mediaUrl: `/media/${mediaId}`, playback: { playing: mediaId === 'a', positionSeconds: 10, serverNow: 0, revision: 3 } })) };
  try {
    const view = render(createElement(QuestionContent, { question, onMediaEnded: (...args: unknown[]) => completions.push(args) }));
    assert.ok(view.getByText(/Before timer.*1.*2/));
    const element = view.container.querySelector('audio')!;
    Object.defineProperty(element, 'duration', { get: () => 5 });
    Object.defineProperty(element, 'readyState', { get: () => 1 });
    fireEvent.loadedMetadata(element);
    await waitFor(() => assert.deepEqual(completions, [['a', 3, 5]]));
    fireEvent.ended(element);
    assert.equal(completions.length, 1);
    view.unmount();
    const host = render(createElement(QuestionContent, { question, host: true }));
    assert.equal((host.getByRole('button', { name: 'Play b' }) as HTMLButtonElement).disabled, true);
    assert.equal((host.getByRole('button', { name: 'Play a' }) as HTMLButtonElement).disabled, false);
  } finally { proto.pause = oldPause; }
});
