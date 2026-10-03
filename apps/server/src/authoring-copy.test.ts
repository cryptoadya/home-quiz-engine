import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createOption, createQuestion, listOptions, listQuestions } from './questions.js';
import { listPairs } from './matching.js';

for (const type of ['single_choice', 'multiple_choice', 'yes_no', 'matching'] as const) {
  test(`copies ${type} drafts with independent answers and all settings`, async () => {
    const db = initializeDatabase(':memory:');
    try {
      const quiz = createQuiz(db), round = createRound(db, quiz.id);
      const question = createQuestion(db, round.id, type);
      const media = [{ mediaId: '11111111-1111-1111-1111-111111111111', playBeforeTimer: true }];
      db.prepare(`UPDATE questions SET text_ru = 'Вопрос', text_en = '', points = 7,
        answer_time_seconds = 43, show_correct_count = 0, explanation_ru = 'Почему',
        explanation_en = 'Why', media_json = ? WHERE id = ?`).run(JSON.stringify(media), question.id);
      if (type === 'single_choice' || type === 'multiple_choice') {
        const option = createOption(db, question.id);
        db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = 1 WHERE id = ?").run(option.id);
      }
      if (type === 'matching') {
        db.prepare('UPDATE matching_pairs SET left_json = ?, right_json = ? WHERE question_id = ?').run(
          JSON.stringify({ kind: 'image', mediaId: media[0].mediaId }), JSON.stringify({ kind: 'text', textRu: 'Кошка', textEn: 'Cat' }), question.id);
      }
      const app = request(createApp(db)), base = `/api/quizzes/${quiz.id}/rounds/${round.id}/questions`;
      const result = await app.post(`${base}/${question.id}/duplicate`);
      assert.equal(result.status, 201);
      const copy = result.body;
      assert.notEqual(copy.id, question.id);
      assert.deepEqual([copy.type, copy.roundId, copy.textRu, copy.textEn, copy.points, copy.answerTimeSeconds,
        copy.showCorrectCount, copy.explanationRu, copy.explanationEn, copy.position],
      [type, round.id, 'Вопрос', '', 7, 43, false, 'Почему', 'Why', 1]);
      assert.deepEqual(copy.media, media);
      const originalAnswers = type === 'matching' ? listPairs(db, question.id) : listOptions(db, question.id);
      const copiedAnswers = type === 'matching' ? listPairs(db, copy.id) : listOptions(db, copy.id);
      assert.equal(copiedAnswers.length, originalAnswers.length);
      for (const [index, answer] of copiedAnswers.entries()) {
        assert.equal(answer.questionId, copy.id);
        assert.ok(!originalAnswers.some(original => original.id === answer.id));
        if ('left' in answer) {
          assert.deepEqual(answer.left, { kind: 'image', mediaId: media[0].mediaId });
          assert.deepEqual(answer.right, { kind: 'text', textRu: 'Кошка', textEn: 'Cat' });
        } else {
          const original = originalAnswers[index];
          assert.ok('textRu' in original);
          assert.deepEqual([answer.textRu, answer.textEn, answer.isCorrect, answer.position],
            [original.textRu, original.textEn, original.isCorrect, original.position]);
        }
      }
      await app.delete(`${base}/${question.id}`);
      assert.equal(listQuestions(db, round.id).length, 1);
      assert.equal((await app.get(`${base}/${copy.id}/${type === 'matching' ? 'pairs' : 'options'}`)).body.length, copiedAnswers.length);
    } finally { db.close(); }
  });
}

test('copies a reserve round, preserves question order and rejects mismatched ownership', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const quiz = createQuiz(db), other = createQuiz(db), round = createRound(db, quiz.id);
    db.prepare(`UPDATE rounds SET title_ru = ?, title_en = ?, description_ru = 'Описание', description_en = 'Description',
      is_tiebreak = 1, show_leaderboard_after = 1, art_media_id = ? WHERE id = ?`).run('Р'.repeat(100), 'R'.repeat(100), '11111111-1111-1111-1111-111111111111', round.id);
    const first = createQuestion(db, round.id, 'matching'), second = createQuestion(db, round.id, 'yes_no');
    db.prepare('UPDATE questions SET position = ? WHERE id = ?').run(4, first.id);
    const app = request(createApp(db)), base = `/api/quizzes/${quiz.id}/rounds`;
    assert.equal((await app.post(`/api/quizzes/${other.id}/rounds/${round.id}/duplicate`)).status, 404);
    assert.equal((await app.post(`${base}/missing/questions/${first.id}/duplicate`)).status, 404);
    assert.equal((await app.post(`${base}/${round.id}/questions/missing/duplicate`)).status, 404);
    const result = await app.post(`${base}/${round.id}/duplicate`);
    assert.equal(result.status, 201);
    const copy = result.body;
    assert.notEqual(copy.id, round.id);
    assert.deepEqual([copy.quizId, copy.position, copy.descriptionRu, copy.descriptionEn, copy.isTiebreak, copy.showLeaderboardAfter, copy.artMediaId],
      [quiz.id, 1, 'Описание', 'Description', true, true, '11111111-1111-1111-1111-111111111111']);
    assert.equal(copy.titleRu, `${'Р'.repeat(92)} (Копия)`);
    assert.equal(copy.titleEn, `${'R'.repeat(93)} (Copy)`);
    const questions = listQuestions(db, copy.id);
    assert.deepEqual(questions.map(question => question.type), ['yes_no', 'matching']);
    assert.ok(questions.every(question => question.id !== first.id && question.id !== second.id));
    assert.equal(listOptions(db, questions[0].id).length, 2);
    assert.equal(listPairs(db, questions[1].id).length, 2);
  } finally { db.close(); }
});

test('failed child copy rolls back the entire question or round copy', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const quiz = createQuiz(db), round = createRound(db, quiz.id), question = createQuestion(db, round.id, 'yes_no');
    db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON answer_options BEGIN SELECT RAISE(ABORT, 'Copy failed'); END;`);
    const app = request(createApp(db)), base = `/api/quizzes/${quiz.id}/rounds/${round.id}`;
    for (const path of [`${base}/questions/${question.id}/duplicate`, `${base}/duplicate`]) {
      assert.equal((await app.post(path)).status, 500);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds').get()!.n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get()!.n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answer_options').get()!.n, 2);
    }
  } finally { db.close(); }
});
