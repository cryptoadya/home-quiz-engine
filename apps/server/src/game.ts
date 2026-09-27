import { absentPlayerPresence, type PlayerPresenceChecker } from './pause.js';
import { getRevealStats, getPlayerResult } from './reveal.js';
import { getSubmission, getAnswerCounts, isQuestionExcluded } from './answers.js';
import type { DatabaseSync } from 'node:sqlite';
import { currentContent } from './snapshot.js';
import { getRoom } from './rooms.js';
import { effectiveDuration, createAnswerTimer, projectAnswerTimer } from './timer.js';
import { getLeaderboard, navigationAction } from './navigation.js';
import { listPlayers } from './players.js';

export type Audience = 'host' | 'screen' | 'player';

function projectGame(db: DatabaseSync, roomId: string, audience: Audience, now: number, presence: PlayerPresenceChecker) {
  const room = getRoom(db, roomId)!;
  if (room.closedAt || room.state === 'LOBBY' || audience === 'player') return null;
  if (room.state === 'PAUSED') {
    const row = db.prepare('SELECT paused_from_state, paused_remaining_ms, pause_reason, paused_player_id FROM game_sessions WHERE id = ?').get(roomId)!;
    return { state: 'PAUSED' as const, pausedFromState: String(row.paused_from_state), remainingMs: row.paused_remaining_ms as number | null,
      ...(audience === 'host' ? { reason: row.pause_reason as 'manual' | 'player_disconnect',
        disconnectedPlayer: row.paused_player_id === null ? null : {
          id: String(row.paused_player_id),
          present: presence(roomId, String(row.paused_player_id)),
          name: String(db.prepare('SELECT display_name FROM session_players WHERE session_id = ? AND id = ?').get(roomId, row.paused_player_id)!.display_name),
        },
      } : {}),
    };
  }
  const { snapshot, round, roundIndex, questionIndex } = currentContent(db, roomId);
  const numbering = { roundNumber: roundIndex + 1, questionCount: round.questions.length };
  if (room.state === 'ROUND_INTRO') return {
    state: 'ROUND_INTRO' as const, ...numbering,
    titleRu: round.titleRu, titleEn: round.titleEn,
    descriptionRu: round.descriptionRu, descriptionEn: round.descriptionEn,
  };
  if (room.state === 'ROUND_END' || room.state === 'LEADERBOARD' || room.state === 'FINAL_RESULTS' || room.state === 'WINNER_SCREEN') {
    const leaderboard = room.state === 'ROUND_END' ? undefined : getLeaderboard(db, roomId);
    return { state: room.state, ...numbering, titleRu: round.titleRu, titleEn: round.titleEn,
      ...(leaderboard ? { leaderboard: room.state === 'WINNER_SCREEN' ? leaderboard.filter(player => player.rank === 1) : leaderboard } : {}),
      ...(audience === 'host' ? { nextAction: navigationAction(room.state, snapshot, roundIndex, questionIndex) } : {}),
    };
  }
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  const reveal = room.state === 'ANSWER_REVEAL';
  const timer = room.state === 'ANSWERING' || reveal ? { timer: readTimer(db, roomId, now), answers: getAnswerCounts(db, roomId, question.id) } : {};
  const common = { ...(audience === 'host' && reveal ? { nextAction: navigationAction(room.state, snapshot, roundIndex, questionIndex) } : {}), state: room.state as 'QUESTION' | 'ANSWERING' | 'ANSWER_REVEAL', ...(reveal ? { statistics: getRevealStats(db, roomId, question.id) } : {}), ...timer, ...numbering, questionNumber: questionIndex! + 1,
    textRu: question.textRu, textEn: question.textEn };
  if (audience === 'host') return { ...common, points: question.points,
    answerTimeSeconds: effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds),
    options: question.options.map(option => ({ textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect })),
  };
  return { ...common, showOptionsOnScreen: question.showOptionsOnScreen,
    ...(question.showOptionsOnScreen || reveal ? { options: question.options.map(option => ({ textRu: option.textRu, textEn: option.textEn, ...(reveal ? { isCorrect: option.isCorrect } : {}) })) } : {}),
  };
}

export function getSurfaceState(db: DatabaseSync, roomId: string, audience: Audience, now = Date.now(), presence: PlayerPresenceChecker = absentPlayerPresence) {
  const room = getRoom(db, roomId);
  if (!room) return null;
  // Player receives only safe metadata, even when the stored content is invalid.
  if (audience === 'player') return { room };
  return { room, players: listPlayers(db, roomId), game: projectGame(db, roomId, audience, now, presence) };
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
  if (row.answer_started_at === null || row.answer_deadline_at === null) return undefined;
  return projectAnswerTimer(String(row.answer_started_at), String(row.answer_deadline_at), now);
}

// Only call after reconnectPlayer verifies the token, room and locked roster.
export function getPlayerGame(db: DatabaseSync, roomId: string, language: 'ru' | 'en', playerId: string, now = Date.now()) {
  const room = getRoom(db, roomId);
  if (!room || room.closedAt || (room.state !== 'ANSWERING' && room.state !== 'ANSWER_REVEAL')) return null;
  const { round, questionIndex } = currentContent(db, roomId);
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  if (question.type === 'matching') return null;
  const reveal = room.state === 'ANSWER_REVEAL';
  const excluded = isQuestionExcluded(db, roomId, question.id, playerId);
  return {
    excluded,
    state: room.state, questionId: question.id,
    ...(question.type === 'multiple_choice' ? { type: question.type, requiredCorrectCount: question.options.filter(option => option.isCorrect).length } : {}),
    ...(reveal ? { result: getPlayerResult(db, roomId, question.id, playerId), ...(question.type === 'multiple_choice' ? { correctOptionIds: question.options.filter(option => option.isCorrect).map(option => option.id) } : { correctOptionId: question.options.find(option => option.isCorrect)!.id }) } : {}),
    submission: getSubmission(db, roomId, question.id, playerId),
    text: language === 'ru' ? question.textRu : question.textEn,
    options: !reveal && excluded ? [] : question.options.map(option => ({ id: option.id, text: language === 'ru' ? option.textRu : option.textEn })),
    ...(reveal ? {} : { timer: readTimer(db, roomId, now) }),
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
      if (question.type === 'matching') return { status: 409, error: 'Matching gameplay is not available yet.' };
      timer = createAnswerTimer(effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds), now);
    } catch { return { status: 409, error: 'Invalid game snapshot, navigation or duration.' }; }
    db.prepare("UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = ?, answer_deadline_at = ? WHERE id = ?")
      .run(timer.startedAt, timer.deadlineAt, roomId);
    db.exec('COMMIT');
    committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
