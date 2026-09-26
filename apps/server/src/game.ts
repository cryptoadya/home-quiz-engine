import type { DatabaseSync } from 'node:sqlite';
import { getGameSnapshot } from './snapshot.js';
import { getRoom } from './rooms.js';
import { effectiveDuration, createAnswerTimer, projectAnswerTimer } from './timer.js';
import { listPlayers } from './players.js';

export type Audience = 'host' | 'screen' | 'player';

// Navigation indexes address the ordered immutable snapshot, never editor IDs.
function currentContent(db: DatabaseSync, roomId: string) {
  const navigation = db.prepare('SELECT current_round_index, current_question_index FROM game_sessions WHERE id = ?').get(roomId);
  const snapshot = getGameSnapshot(db, roomId);
  if (!navigation || !snapshot || navigation.current_round_index === null) throw new Error('Invalid game navigation.');
  const roundIndex = Number(navigation.current_round_index);
  const round = snapshot.rounds[roundIndex];
  if (!round) throw new Error('Current round not found.');
  const questionIndex = navigation.current_question_index === null ? null : Number(navigation.current_question_index);
  return { snapshot, round, roundIndex, questionIndex };
}

function projectGame(db: DatabaseSync, roomId: string, audience: Audience, now: number) {
  const room = getRoom(db, roomId)!;
  if (room.closedAt || room.state === 'LOBBY' || audience === 'player') return null;
  const { snapshot, round, roundIndex, questionIndex } = currentContent(db, roomId);
  const numbering = { roundNumber: roundIndex + 1, questionCount: round.questions.length };
  if (room.state === 'ROUND_INTRO') return {
    state: 'ROUND_INTRO' as const, ...numbering,
    titleRu: round.titleRu, titleEn: round.titleEn,
    descriptionRu: round.descriptionRu, descriptionEn: round.descriptionEn,
  };
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  const timer = room.state === 'ANSWERING' ? { timer: readTimer(db, roomId, now) } : {};
  const common = { state: room.state as 'QUESTION' | 'ANSWERING', ...timer, ...numbering, questionNumber: questionIndex! + 1,
    textRu: question.textRu, textEn: question.textEn };
  if (audience === 'host') return { ...common, points: question.points,
    answerTimeSeconds: effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds),
    options: question.options.map(option => ({ textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect })),
  };
  return { ...common, showOptionsOnScreen: question.showOptionsOnScreen,
    ...(question.showOptionsOnScreen ? { options: question.options.map(option => ({ textRu: option.textRu, textEn: option.textEn })) } : {}),
  };
}

export function getSurfaceState(db: DatabaseSync, roomId: string, audience: Audience, now = Date.now()) {
  const room = getRoom(db, roomId);
  if (!room) return null;
  // Player receives only safe metadata, even when the stored content is invalid.
  if (audience === 'player') return { room };
  return { room, players: listPlayers(db, roomId), game: projectGame(db, roomId, audience, now) };
}

export function startRound(db: DatabaseSync, roomId: string) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || room.state !== 'ROUND_INTRO') return { status: 409, error: 'Room is not in an active Round Intro.' };
    try {
      const { round } = currentContent(db, roomId);
      if (!round.questions.length) return { status: 409, error: 'Round has no questions.' };
    } catch { return { status: 409, error: 'Invalid game snapshot or navigation.' }; }
    db.prepare("UPDATE game_sessions SET state = 'QUESTION', current_question_index = 0 WHERE id = ?").run(roomId);
    db.exec('COMMIT');
    committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}

function readTimer(db: DatabaseSync, roomId: string, now: number) {
  const row = db.prepare('SELECT answer_started_at, answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId)!;
  return projectAnswerTimer(String(row.answer_started_at), String(row.answer_deadline_at), now);
}

// Only call after reconnectPlayer verifies the token, room and locked roster.
export function getPlayerGame(db: DatabaseSync, roomId: string, language: 'ru' | 'en', now = Date.now()) {
  const room = getRoom(db, roomId);
  if (!room || room.closedAt || room.state !== 'ANSWERING') return null;
  const { round, questionIndex } = currentContent(db, roomId);
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  return {
    state: 'ANSWERING' as const, questionId: question.id,
    text: language === 'ru' ? question.textRu : question.textEn,
    options: question.options.map(option => ({ id: option.id, text: language === 'ru' ? option.textRu : option.textEn })),
    timer: readTimer(db, roomId, now),
  };
}

export function startQuestion(db: DatabaseSync, roomId: string, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || room.state !== 'QUESTION') return { status: 409, error: 'Room is not in an active Question.' };
    let timer;
    try {
      const { snapshot, round, questionIndex } = currentContent(db, roomId);
      const question = questionIndex === null ? undefined : round.questions[questionIndex];
      if (!question) throw new Error('Current question not found.');
      timer = createAnswerTimer(effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds), now);
    } catch { return { status: 409, error: 'Invalid game snapshot, navigation or duration.' }; }
    db.prepare("UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = ?, answer_deadline_at = ? WHERE id = ?")
      .run(timer.startedAt, timer.deadlineAt, roomId);
    db.exec('COMMIT');
    committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
