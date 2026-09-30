import './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Questions, type Option, type Pair, type Question } from './Questions';

const base = '/api/quizzes/quiz/rounds/round/questions';
const blank = () => ({ kind: 'text' as const, textRu: '', textEn: '' });
const question = (id: string, type: Question['type'] = 'single_choice'): Question => ({
  id, roundId: 'round', type, textRu: '', textEn: id.toUpperCase(), points: 1,
  answerTimeSeconds: null, showOptionsOnScreen: false, position: id === 'a' ? 0 : 1,
  createdAt: '', updatedAt: '',
});
const option = (id: string, questionId: string, position = 0): Option => ({
  id, questionId, textRu: id, textEn: id, isCorrect: false, position, createdAt: '', updatedAt: '',
});
const pair = (id: string, questionId: string, position = 0): Pair => ({
  id, questionId, left: { kind: 'text', textRu: id, textEn: id }, right: blank(), position,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function editorFixture(kind: 'options' | 'pairs', ids: string[] = ['a']) {
  const originalFetch = globalThis.fetch;
  const questions = ids.map(id => question(id, kind === 'pairs' ? 'matching' : 'single_choice'));
  const items = new Map<string, Array<Option | Pair>>(ids.map(id => [id, kind === 'pairs'
    ? [pair(`${id}1`, id), pair(`${id}2`, id, 1)]
    : [option(`${id}1`, id)]] as const));
  const held: { path: string; reply: ReturnType<typeof deferred<Response>>; snapshot: unknown[] }[] = [];
  const writes: string[] = [];
  const holdNext = new Set<string>();
  let failNext = '';
  globalThis.fetch = async (input, init) => {
    const path = String(input); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === base && method === 'GET') return Response.json(questions);
    const match = path.match(/\/questions\/([^/]+)(?:\/(options|pairs))?(?:\/(.*))?$/);
    if (!match) throw Error(`Unexpected ${method} ${path}`);
    const [, id, child, suffix] = match;
    const current = items.get(id)!;
    if (!child && method === 'PUT') {
      const target = questions.find(item => item.id === id)!;
      Object.assign(target, body);
      if (target.type === 'matching') items.set(id, [pair(`${id}new1`, id), pair(`${id}new2`, id, 1)]);
      return Response.json(target);
    }
    if (child && !suffix && method === 'GET') {
      const snapshot = structuredClone(items.get(id)!);
      if (failNext === path) { failNext = ''; return Response.json({ error: 'Old load failed' }, { status: 500 }); }
      if (holdNext.delete(path)) {
        const reply = deferred<Response>(); held.push({ path, reply, snapshot }); return reply.promise;
      }
      return Response.json(snapshot);
    }
    if (child && !suffix && method === 'POST') {
      const created = child === 'pairs' ? pair(`${id}${current.length + 1}`, id, current.length) : option(`${id}${current.length + 1}`, id, current.length);
      current.push(created); return Response.json(created, { status: 201 });
    }
    if (child && suffix === 'order' && method === 'PUT') {
      const ordered = body.ids.map((itemId: string, position: number) => ({ ...current.find(item => item.id === itemId)!, position }));
      items.set(id, ordered); return Response.json(ordered);
    }
    if (child && suffix && method === 'DELETE') {
      items.set(id, current.filter(item => item.id !== suffix)); return new Response(null, { status: 204 });
    }
    if (child && suffix && method === 'PUT') {
      writes.push(path);
      const target = current.find(item => item.id === suffix)!;
      Object.assign(target, body); return Response.json(target);
    }
    throw Error(`Unexpected ${method} ${path}`);
  };
  return {
    questions, items, held, writes, holdNext,
    failNext(path: string) { failNext = path; },
    restore() { globalThis.fetch = originalFetch; },
    render() { return render(createElement(Questions, { quizId: 'quiz', roundId: 'round' })); },
    async resolve(index: number, failed = false) {
      await act(async () => held[index].reply.resolve(failed
        ? Response.json({ error: 'Late A failed' }, { status: 500 })
        : Response.json(held[index].snapshot)));
    },
  };
}

afterEach(cleanup);

for (const kind of ['options', 'pairs'] as const) test(`late ${kind} reload from A cannot replace B or route B edits to A`, async () => {
  const fixture = editorFixture(kind, ['a', 'b']);
  const aPath = `${base}/a/${kind}`;
  try {
    if (kind === 'pairs') {
      fixture.questions[0].type = 'single_choice';
      fixture.items.set('a', [option('a1', 'a')]);
    }
    const view = fixture.render();
    const field = kind === 'pairs' ? 'Pair 1 left EN' : 'Option 1 EN';
    await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
    fixture.holdNext.add(aPath);
    fireEvent.change(view.getByLabelText('Question type'), { target: { value: kind === 'pairs' ? 'matching' : 'multiple_choice' } });
    await waitFor(() => assert.equal(fixture.held.length, 1));
    fireEvent.click(view.getByRole('button', { name: '2. B' }));
    await waitFor(() => assert.equal((view.getByLabelText(field) as HTMLInputElement).value, 'b1'));
    await fixture.resolve(0);
    assert.equal((view.getByLabelText(field) as HTMLInputElement).value, 'b1');
    assert.equal((view.getByLabelText('Question text EN') as HTMLTextAreaElement).value, 'B');
    assert.equal(view.getByRole('heading', { name: `${kind === 'pairs' ? 'Matching' : 'Single Choice'} question` }).textContent?.includes('question'), true);
    fireEvent.change(view.getByLabelText(field), { target: { value: 'B edited' } });
    await waitFor(() => assert.ok(fixture.writes.length));
    assert.deepEqual(fixture.writes, [`${base}/b/${kind}/b1`]);
  } finally { fixture.restore(); }
});

for (const kind of ['options', 'pairs'] as const) test(`initial ${kind} GET cannot remove an added child`, async () => {
  const fixture = editorFixture(kind);
  fixture.holdNext.add(`${base}/a/${kind}`);
  try {
    const view = fixture.render();
    await waitFor(() => assert.equal(fixture.held.length, 1));
    fireEvent.click(view.getByRole('button', { name: kind === 'pairs' ? 'Add pair' : 'Add option' }));
    const field = kind === 'pairs' ? 'Pair 2 left EN' : 'Option 2 EN';
    await waitFor(() => assert.ok(view.queryByLabelText(field)));
    await fixture.resolve(0);
    assert.ok(view.queryByLabelText(field));
    assert.equal(view.getAllByLabelText(kind === 'pairs' ? /Pair \d left EN/ : /Option \d EN/).length, fixture.items.get('a')!.length);
    assert.equal((view.getByLabelText(kind === 'pairs' ? 'Pair 1 left EN' : 'Option 1 EN') as HTMLInputElement).value, 'a1');
    assert.equal((view.getByLabelText(field) as HTMLInputElement).value, 'a2');
  } finally { fixture.restore(); }
});

for (const action of ['delete', 'reorder'] as const) test(`old options GET cannot undo successful ${action}`, async () => {
  const fixture = editorFixture('options');
  fixture.items.set('a', []);
  fixture.holdNext.add(`${base}/a/options`);
  try {
    const view = fixture.render();
    await waitFor(() => assert.equal(fixture.held.length, 1));
    fireEvent.click(view.getByRole('button', { name: 'Add option' }));
    await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
    fireEvent.click(view.getByRole('button', { name: 'Add option' }));
    await waitFor(() => assert.ok(view.getByLabelText('Option 2 EN')));
    if (action === 'delete') {
      fireEvent.click(view.getByRole('button', { name: 'Delete option 1' }));
      await waitFor(() => assert.equal(fixture.items.get('a')!.length, 1));
    } else {
      fireEvent.click(view.getByRole('button', { name: 'Move option 2 up' }));
      await waitFor(() => assert.equal(fixture.items.get('a')![0].id, 'a2'));
    }
    await fixture.resolve(0);
    assert.equal((view.getByLabelText('Option 1 EN') as HTMLInputElement).value, (fixture.items.get('a')![0] as Option).textEn);
  } finally { fixture.restore(); }
});

test('late failed A reload does not show an error or Retry for B', async () => {
  const fixture = editorFixture('options', ['a', 'b']);
  try {
    const view = fixture.render();
    await waitFor(() => assert.ok(view.getByLabelText('Option 1 EN')));
    fixture.holdNext.add(`${base}/a/options`);
    fireEvent.change(view.getByLabelText('Question type'), { target: { value: 'multiple_choice' } });
    await waitFor(() => assert.equal(fixture.held.length, 1));
    fireEvent.click(view.getByRole('button', { name: '2. B' }));
    await waitFor(() => assert.equal((view.getByLabelText('Option 1 EN') as HTMLInputElement).value, 'b1'));
    await fixture.resolve(0, true);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(view.queryByRole('button', { name: 'Retry answer data' }), null);
  } finally { fixture.restore(); }
});

test('newest Retry answer data replaces the current options', async () => {
  const fixture = editorFixture('options');
  fixture.failNext(`${base}/a/options`);
  try {
    const view = fixture.render();
    await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry answer data' })));
    fixture.holdNext.add(`${base}/a/options`);
    fireEvent.click(view.getByRole('button', { name: 'Retry answer data' }));
    await waitFor(() => assert.equal(fixture.held.length, 1));
    fixture.items.set('a', [option('fresh', 'a')]);
    await act(async () => fixture.held[0].reply.resolve(Response.json(fixture.items.get('a'))));
    await waitFor(() => assert.equal((view.getByLabelText('Option 1 EN') as HTMLInputElement).value, 'fresh'));
    assert.equal(view.queryByRole('button', { name: 'Retry answer data' }), null);
    assert.equal(view.queryByRole('alert'), null);
  } finally { fixture.restore(); }
});
