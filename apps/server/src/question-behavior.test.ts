import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz, duplicateQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption, updateOption, listOptions, listQuestions } from './questions.js';
import { listPairs, updatePair } from './matching.js';
import { getGameSnapshot, parseGameSnapshot } from './snapshot.js';
import { getPlayerGame, startQuestion, getSurfaceState } from './game.js';
import { matchingContent } from './matching-game.js';
import { answerOrder } from './answer-order.js';
import { submitAnswer } from './answers.js';

for (const legacyFlag of [false, true]) for (const shuffle of [false, true]) for (const hint of [false, true]) test(`mixed frozen quiz: legacy=${legacyFlag}, shuffle=${shuffle}, hint=${hint}, Players/reconnect/restart/scoring`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-behavior-'));
  const path = join(dir, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    let api = request(createApp(db));
    const quiz = createQuiz(db), round = createRound(db, quiz.id);
    db.prepare('UPDATE quizzes SET shuffle_answers = ? WHERE id = ?').run(Number(shuffle), quiz.id);
    for (const type of ['single_choice', 'yes_no', 'multiple_choice', 'matching'] as const) {
      const q = createQuestion(db, round.id, type);
      const fields = { type, textRu: 'Вопрос', textEn: 'Question', points: 5, answerTimeSeconds: 30, showOptionsOnScreen: legacyFlag, showCorrectCount: hint };
      const base = `/api/quizzes/${quiz.id}/rounds/${round.id}/questions/${q.id}`;
      await api.put(base).send({ ...fields, showCorrectCount: 'invalid' }).expect(400);
      assert.equal((await api.put(base).send(fields).expect(200)).body.showCorrectCount, hint);
      const { showCorrectCount: _hint, ...olderFields } = fields;
      assert.equal((await api.put(base).send(olderFields).expect(200)).body.showCorrectCount, hint);
      if (type === 'matching') listPairs(db, q.id).forEach((pair, i) => updatePair(db, q.id, pair.id, { left: { kind: 'text', textRu: `Л ${i}`, textEn: `Left ${i}` }, right: { kind: 'text', textRu: `П ${i}`, textEn: `Right ${i}` } }));
      else if (type !== 'yes_no') for (let i = 0; i < 4; i++) updateOption(db, q.id, createOption(db, q.id).id, { textRu: `О ${i}`, textEn: `Option ${i}`, isCorrect: type === 'multiple_choice' ? i < 2 : i === 0 });
    }
    const source = listQuestions(db, round.id);
    const authored = source.map(q => q.type === 'matching' ? listPairs(db, q.id) : listOptions(db, q.id));
    const copy = duplicateQuiz(db, quiz.id)!;
    const copiedRound = db.prepare('SELECT id FROM rounds WHERE quiz_id = ?').get(copy.id)!;
    assert.ok(listQuestions(db, String(copiedRound.id)).every(q => q.showCorrectCount === hint));
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    const root = `/api/rooms/${room.id}`;
    const players = [];
    for (const name of ['Alice', 'Bob']) players.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
    await api.post(`${root}/start`).expect(200);
    const snapshot = getGameSnapshot(db, room.id)!;
    assert.equal(snapshot.schemaVersion, 1);
    assert.ok(snapshot.rounds[0].questions.every(q => q.showCorrectCount === hint));
    const legacy = structuredClone(snapshot);
    legacy.rounds[0].questions.forEach(q => { delete q.showCorrectCount; });
    assert.doesNotThrow(() => parseGameSnapshot(JSON.stringify(legacy)));
    const malformed = structuredClone(snapshot) as any;
    malformed.rounds[0].questions[0].showCorrectCount = 1;
    assert.throws(() => parseGameSnapshot(JSON.stringify(malformed)));
    assert.deepEqual(source.map(q => q.type === 'matching' ? listPairs(db, q.id) : listOptions(db, q.id)), authored);
    db.prepare('UPDATE questions SET show_correct_count = ? WHERE round_id = ?').run(Number(!hint), round.id);
    db.prepare('UPDATE quizzes SET shuffle_answers = ? WHERE id = ?').run(Number(!shuffle), quiz.id);
    await api.post(`${root}/start-round`).expect(200);
    for (const [index, q] of snapshot.rounds[0].questions.entries()) {
      if (index) await api.post(`${root}/next`).expect(200);
      const prepared = (getSurfaceState(db, room.id, 'screen') as any).game;
      assert.equal(prepared.textEn, ''); assert.deepEqual(prepared.media, []);
      assert.doesNotMatch(JSON.stringify(prepared), /options|leftItems|rightItems|correctMapping|isCorrect|requiredCorrectCount|showOptionsOnScreen/);
      assert.ok('room' in startQuestion(db, room.id, Date.now()));
      const game = getPlayerGame(db, room.id, 'en', players[0].player.id) as any;
      const screen = (getSurfaceState(db, room.id, 'screen') as any).game;
      assert.equal(screen.textEn, 'Question'); assert.ok(Array.isArray(screen.media));
      assert.doesNotMatch(JSON.stringify(screen), /options|leftItems|rightItems|correctMapping|isCorrect|requiredCorrectCount|showOptionsOnScreen/);
      const order = (g: any) => ({ options: g.options, leftItems: g.leftItems, rightItems: g.rightItems });
      assert.deepEqual(order(getPlayerGame(db, room.id, 'en', players[1].player.id)), order(game));
      assert.doesNotMatch(JSON.stringify(game), /isCorrect|correctOptionIds?|correctMapping|showCorrectCount|"position"|"pairs"/);
      if (q.type === 'multiple_choice') {
        assert.equal(Object.hasOwn(game, 'requiredCorrectCount'), hint);
        if (hint) assert.equal(game.requiredCorrectCount, 2);
      }
      if (q.type === 'matching') {
        const content = matchingContent(room.id, q, shuffle);
        assert.deepEqual(game.leftItems.map((i: any) => i.id), content.leftItems.map(i => i.id));
        assert.deepEqual(game.rightItems.map((i: any) => i.id), content.rightItems.map(i => i.id));
        if (!shuffle) {
          assert.deepEqual(game.leftItems.map((i: any) => i.text), q.pairs!.map(p => p.left.kind === 'text' ? p.left.textEn : ''));
          assert.deepEqual(game.rightItems.map((i: any) => i.text), q.pairs!.map(p => p.right.kind === 'text' ? p.right.textEn : ''));
        }
        for (const [i, mapping] of content.correctMapping.entries()) {
          assert.equal(game.leftItems.find((item: any) => item.id === mapping.leftId).text, `Left ${i}`);
          assert.equal(game.rightItems.find((item: any) => item.id === mapping.rightId).text, `Right ${i}`);
        }
      } else {
        assert.deepEqual(game.options.map((o: any) => o.id), answerOrder(q.options, shuffle, room.id, q.id).map(o => o.id));
      }
      db.close(); db = initializeDatabase(path); api = request(createApp(db));
      assert.deepEqual(order(getPlayerGame(db, room.id, 'en', players[0].player.id)), order(game));
      const reconnect = (await api.post(`${root}/reconnect`).send({ token: players[0].token }).expect(200)).body;
      assert.deepEqual(order(reconnect.game), order(game));
      const correct = q.options.filter(o => o.isCorrect).map(o => o.id);
      const mapping = matchingContent(room.id, q, shuffle).correctMapping;
      for (const [i, p] of players.entries()) {
        const answer = q.type === 'matching' ? { mapping: i === 0 ? mapping : mapping.map((pair, n) => ({ ...pair, rightId: mapping[(n + 1) % mapping.length].rightId })) } : q.type === 'multiple_choice' ? { optionIds: i === 0 ? correct : [correct[0]] } : { optionId: i === 0 ? correct[0] : q.options.find(o => !o.isCorrect)!.id };
        assert.ok('submission' in submitAnswer(db, room.id, { token: p.token, questionId: q.id, ...answer }));
      }
      const revealed = (getSurfaceState(db, room.id, 'screen') as any).game;
      if (q.type === 'matching') {
        assert.deepEqual(revealed.correctMapping, mapping);
        assert.equal(revealed.leftItems.length, q.pairs!.length);
        assert.equal(revealed.rightItems.length, q.pairs!.length);
        assert.equal(revealed.options, undefined);
      } else {
        assert.deepEqual(revealed.options.map((o: any) => o.textEn).sort(), q.options.filter(o => o.isCorrect).map(o => o.textEn).sort());
        assert.ok(revealed.options.every((o: any) => o.isCorrect));
      }
      assert.deepEqual((getPlayerGame(db, room.id, 'en', players[0].player.id) as any).result, { outcome: 'correct', points: 5 });
      assert.deepEqual((getPlayerGame(db, room.id, 'en', players[1].player.id) as any).result, { outcome: 'wrong', points: 0 });
    }
    assert.equal(db.prepare('SELECT SUM(awarded_points) n FROM question_scores WHERE player_id = ?').get(players[0].player.id)!.n, 20);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deterministic shuffle changes order and independently permutes Matching sides without mutation', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const original = structuredClone(items);
  const left = answerOrder(items, true, 'room', 'question', 'left');
  const right = answerOrder(items, true, 'room', 'question', 'right');
  assert.notDeepEqual(left, original);
  assert.notDeepEqual(left, right);
  assert.deepEqual(items, original);
  assert.deepEqual(answerOrder(items, false, 'room', 'question'), original);
});

test('Matching shuffle preserves opaque IDs, image structures and correct mapping', () => {
  const question = { id: 'question', pairs: Array.from({ length: 10 }, (_, i) => ({ id: String(i), left: { kind: 'image' as const, mediaId: `left-${i}` }, right: { kind: 'image' as const, mediaId: `right-${i}` } })) };
  const authored = matchingContent('room', question, false);
  const shuffled = matchingContent('room', question, true);
  assert.notDeepEqual(shuffled.leftItems, authored.leftItems);
  assert.notDeepEqual(shuffled.rightItems, authored.rightItems);
  assert.deepEqual(shuffled.correctMapping, authored.correctMapping);
  for (const [i, pair] of shuffled.correctMapping.entries()) {
    assert.deepEqual(shuffled.leftItems.find(item => item.id === pair.leftId), { id: pair.leftId, kind: 'image', mediaId: `left-${i}`, mediaUrl: `/api/rooms/room/media/left-${i}/content` });
    assert.deepEqual(shuffled.rightItems.find(item => item.id === pair.rightId), { id: pair.rightId, kind: 'image', mediaId: `right-${i}`, mediaUrl: `/api/rooms/room/media/right-${i}/content` });
  }
  assert.deepEqual(shuffled, matchingContent('room', question, true));
});
