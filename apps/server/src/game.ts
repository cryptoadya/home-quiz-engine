import { projectMediaPlayback, preTimerMediaId, beginMedia, beginAnswering } from './media-playback.js';
import { answerOrder } from './answer-order.js';
import { matchingContent } from './matching-game.js';
import { absentPlayerPresence, type PlayerPresenceChecker } from './pause.js';
import { getRevealStats, getPlayerResult } from './reveal.js';
import { getSubmission, getAnswerCounts, isQuestionExcluded } from './answers.js';
import type { DatabaseSync } from 'node:sqlite';
import { currentContent } from './snapshot.js';
import { getRoom } from './rooms.js';
import { effectiveDuration, projectAnswerTimer } from './timer.js';
import { getLeaderboard, navigationAction } from './navigation.js';
import { listPlayers } from './players.js';

export type Audience = 'host' | 'screen' | 'player';

function projectActiveGame(db: DatabaseSync, roomId: string, audience: Audience, now: number, underlyingState?: string) {
  const room = getRoom(db, roomId)!;
  if (underlyingState) room.state = underlyingState as typeof room.state;
  if (room.closedAt || room.state === 'LOBBY' || audience === 'player') return null;
  const { snapshot, round, roundIndex, questionIndex } = currentContent(db, roomId);
  const numbering = { roundNumber: roundIndex + 1, questionCount: round.questions.length };
  if (room.state === 'ROUND_INTRO') return {
    ...(round.artMediaId ? { artUrl: `/api/rooms/${roomId}/media/${round.artMediaId}/content` } : {}), state: 'ROUND_INTRO' as const, ...numbering,
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
  const preTimer = preTimerMediaId(db, roomId);
  const ordered = question.media?.filter(ref => ref.playBeforeTimer) ?? [];
  const common = { ...(preTimer ? { preTimer: { mediaId: preTimer, number: ordered.findIndex(ref => ref.mediaId === preTimer) + 1, total: ordered.length } } : {}), ...(audience === 'host' && reveal ? { nextAction: navigationAction(room.state, snapshot, roundIndex, questionIndex) } : {}), state: room.state as 'QUESTION' | 'ANSWERING' | 'ANSWER_REVEAL', ...(reveal ? { statistics: getRevealStats(db, roomId, question.id) } : {}), ...timer, ...numbering, questionNumber: questionIndex! + 1,
    questionId: question.id, textRu: question.textRu, textEn: question.textEn,
    ...(audience === 'host' || reveal ? { explanationRu: question.explanationRu ?? '', explanationEn: question.explanationEn ?? '' } : {}),
    media: (question.media ?? []).flatMap(ref => {
      const media = snapshot.media?.find(item => item.id === ref.mediaId);
      return media ? [{ mediaId: media.id, name: media.name, mediaUrl: `/api/rooms/${roomId}/media/${media.id}/content`, ...(media.kind === 'image' ? {} : { kind: media.kind, playBeforeTimer: ref.playBeforeTimer, playback: projectMediaPlayback(db, roomId, question.id, media.id, now) }) }] : [];
    }) };
  const matching = question.type === 'matching' ? matchingContent(roomId, question, snapshot.shuffleAnswers) : undefined;
  const matchingProjection = matching ? { type: 'matching' as const, leftItems: matching.leftItems, rightItems: matching.rightItems,
    ...(audience === 'host' || reveal ? { correctMapping: matching.correctMapping } : {}) } : {};
  if (audience === 'host') return { ...common, ...matchingProjection, points: question.points,
    answerTimeSeconds: effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds),
    options: answerOrder(question.options, snapshot.shuffleAnswers, roomId, question.id).map(option => ({ textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect })),
  };
  return { ...common, ...matchingProjection, showOptionsOnScreen: question.showOptionsOnScreen,
    ...(question.showOptionsOnScreen || reveal ? { options: answerOrder(question.options, snapshot.shuffleAnswers, roomId, question.id).map(option => ({ textRu: option.textRu, textEn: option.textEn, ...(reveal ? { isCorrect: option.isCorrect } : {}) })) } : {}),
  };
}

function projectGame(db: DatabaseSync, roomId: string, audience: Audience, now: number, presence: PlayerPresenceChecker) {
  const room = getRoom(db, roomId)!;
  if (room.closedAt || audience === 'player') return null;
  if (room.state === 'PAUSED') {
    const row = db.prepare('SELECT paused_from_state, paused_remaining_ms, pause_reason, paused_player_id FROM game_sessions WHERE id = ?').get(roomId)!;
    const content = ['QUESTION', 'ANSWERING', 'ANSWER_REVEAL'].includes(String(row.paused_from_state))
      ? projectActiveGame(db, roomId, audience, now, String(row.paused_from_state)) : null;
    return { ...(content ? { content } : {}), state: 'PAUSED' as const, pausedFromState: String(row.paused_from_state), remainingMs: row.paused_remaining_ms as number | null,
      ...(audience === 'host' ? { reason: row.pause_reason as 'manual' | 'player_disconnect',
        disconnectedPlayer: row.paused_player_id === null ? null : {
          id: String(row.paused_player_id),
          present: presence(roomId, String(row.paused_player_id)),
          name: String(db.prepare('SELECT display_name FROM session_players WHERE session_id = ? AND id = ?').get(roomId, row.paused_player_id)!.display_name),
        },
      } : {}),
    };
  }
  return projectActiveGame(db, roomId, audience, now);
}

export function getSurfaceState(db: DatabaseSync, roomId: string, audience: Audience, now = Date.now(), presence: PlayerPresenceChecker = absentPlayerPresence) {
  const room = getRoom(db, roomId);
  if (!room) return null;
  // Player receives only safe metadata, even when the stored content is invalid.
  if (audience === 'player') return { room };
  return { room, players: listPlayers(db, roomId).map(player => ({ ...player, ...(audience === 'host' ? { present: !room.closedAt && presence(roomId, player.id) } : {}) })), game: projectGame(db, roomId, audience, now, presence) };
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
  const { snapshot, round, questionIndex } = currentContent(db, roomId);
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  const reveal = room.state === 'ANSWER_REVEAL';
  const excluded = isQuestionExcluded(db, roomId, question.id, playerId);
  const matching = question.type === 'matching' ? matchingContent(roomId, question, snapshot.shuffleAnswers) : undefined;
  const localizedItems = (items: NonNullable<typeof matching>['leftItems']) => items.map(item => item.kind === 'text'
    ? { id: item.id, kind: item.kind, text: language === 'ru' ? item.textRu : item.textEn }
    : item);

  return {
    excluded,
    state: room.state, questionId: question.id,
    ...(question.type === 'multiple_choice' ? { type: question.type, ...(question.showCorrectCount !== false ? { requiredCorrectCount: question.options.filter(option => option.isCorrect).length } : {}) } : {}),
    ...(matching ? { type: 'matching' as const, leftItems: !reveal && excluded ? [] : localizedItems(matching.leftItems), rightItems: !reveal && excluded ? [] : localizedItems(matching.rightItems), ...(reveal ? { correctMapping: matching.correctMapping } : {}) } : {}),
    ...(reveal ? { result: getPlayerResult(db, roomId, question.id, playerId), ...(question.type === 'matching' ? {} : question.type === 'multiple_choice' ? { correctOptionIds: question.options.filter(option => option.isCorrect).map(option => option.id) } : { correctOptionId: question.options.find(option => option.isCorrect)!.id }) } : {}),
    submission: getSubmission(db, roomId, question.id, playerId),
    text: language === 'ru' ? question.textRu : question.textEn,
    options: !reveal && excluded ? [] : answerOrder(question.options, snapshot.shuffleAnswers, roomId, question.id).map(option => ({ id: option.id, text: language === 'ru' ? option.textRu : option.textEn })),
    ...(reveal ? {} : { timer: readTimer(db, roomId, now) }),
  };
}

export function startQuestion(db: DatabaseSync, roomId: string, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || room.state !== 'QUESTION' || preTimerMediaId(db, roomId)) return { status: 409, error: 'Room is not in an active Question.' };
    let question;
    try {
      const { snapshot, round, questionIndex } = currentContent(db, roomId);
      question = round.questions[questionIndex!];
      if (!question) throw new Error('Missing question.');
      effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds);
    } catch { return { status: 409, error: 'Invalid game snapshot, navigation or duration.' }; }
    const first = question.media?.find(ref => ref.playBeforeTimer);
    if (first) {
      db.prepare('UPDATE game_sessions SET pre_timer_media_id = ? WHERE id = ?').run(first.mediaId, roomId);
      beginMedia(db, roomId, question.id, first.mediaId, now);
    } else beginAnswering(db, roomId, now);
    db.exec('COMMIT');
    committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
