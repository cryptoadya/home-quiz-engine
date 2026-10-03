import { listMedia, validMediaMetadata, validMediaReferences, type Media, type MediaReference } from './media.js';
import { listPairs, validMatchingSide, type MatchingPair } from './matching.js';
import type { DatabaseSync } from 'node:sqlite';
import { getQuiz, type Quiz } from './quizzes.js';
import { listRounds, type Round } from './rounds.js';
import { listQuestions, listOptions, type Question, type AnswerOption } from './questions.js';

type SnapshotOption = Pick<AnswerOption, 'id' | 'textRu' | 'textEn' | 'isCorrect' | 'position'>;
type SnapshotQuestion = Pick<Question, 'id' | 'type' | 'textRu' | 'textEn' | 'points' | 'answerTimeSeconds' | 'showOptionsOnScreen' | 'position'> & { explanationRu?: string; explanationEn?: string; media?: MediaReference[]; showCorrectCount?: boolean; options: SnapshotOption[]; pairs?: Pick<MatchingPair, 'id' | 'left' | 'right' | 'position'>[] };
type SnapshotRound = Pick<Round, 'id' | 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'showLeaderboardAfter' | 'position'> & { isTiebreak?: boolean; artMediaId?: string | null; questions: SnapshotQuestion[] };
export type GameSnapshot = Pick<Quiz, 'title' | 'defaultAnswerTimeSeconds' | 'shuffleAnswers'> & { themeId: string; schemaVersion: 1; media?: Omit<Media, 'quizId'>[]; rounds: SnapshotRound[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const ordered = (value: unknown, valid: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length > 0 && value.every((item, index) =>
  valid(item) && record(item) && integer(item.position, 0) && (index === 0 || Number(item.position) >= Number(value[index - 1].position)));

function validOption(value: unknown): boolean {
  return record(value) && strings(value, ['id', 'textRu', 'textEn']) && typeof value.isCorrect === 'boolean';
}
function validQuestion(value: unknown): boolean {
  if (!record(value) || !strings(value, ['id', 'textRu', 'textEn'])
    || !integer(value.points, 1) || !(value.answerTimeSeconds === null || integer(value.answerTimeSeconds, 1, 3600))
    || (value.media !== undefined && !validMediaReferences(value.media))
    || typeof value.showOptionsOnScreen !== 'boolean' || (value.showCorrectCount !== undefined && typeof value.showCorrectCount !== 'boolean')) return false;
  if (value.explanationRu !== undefined || value.explanationEn !== undefined) {
    if (!strings(value, ['explanationRu', 'explanationEn']) || String(value.explanationRu).length > 5000 || String(value.explanationEn).length > 5000 || Boolean(String(value.explanationRu).trim()) !== Boolean(String(value.explanationEn).trim())) return false;
  }
  if (value.type === 'matching') {
    return Array.isArray(value.options) && value.options.length === 0
      && ordered(value.pairs, pair => record(pair) && typeof pair.id === 'string' && pair.id.trim().length > 0
        && validMatchingSide(pair.left, true) && validMatchingSide(pair.right, true))
      && value.pairs.length >= 2 && new Set(value.pairs.map(pair => (pair as MatchingPair).id)).size === value.pairs.length;
  }
  return (value.type === 'single_choice' || value.type === 'yes_no' || value.type === 'multiple_choice')
    && (value.pairs === undefined || (Array.isArray(value.pairs) && value.pairs.length === 0))
    && ordered(value.options, validOption)
    && (value.type === 'yes_no' ? value.options.length === 2 : value.options.length >= 2 && value.options.length <= 10)
    && (value.type === 'multiple_choice' ? value.options.filter(option => (option as SnapshotOption).isCorrect).length >= 2 : value.options.filter(option => (option as SnapshotOption).isCorrect).length === 1);
}
function validRound(value: unknown): boolean {
  return record(value) && strings(value, ['id', 'titleRu', 'titleEn', 'descriptionRu', 'descriptionEn'])
    && (value.isTiebreak === undefined || typeof value.isTiebreak === 'boolean')
    && typeof value.showLeaderboardAfter === 'boolean' && ordered(value.questions, validQuestion);
}

export function parseGameSnapshot(json: string): GameSnapshot {
  const value: unknown = JSON.parse(json);
  if (!record(value) || value.schemaVersion !== 1 || !strings(value, ['title'])
    || (value.themeId != null && typeof value.themeId !== 'string')
    || !integer(value.defaultAnswerTimeSeconds, 1, 3600) || typeof value.shuffleAnswers !== 'boolean'
    || !ordered(value.rounds, validRound)) throw new Error('Invalid game snapshot.');
  const snapshot = { ...value, themeId: value.themeId ?? 'default' } as GameSnapshot;
  if (snapshot.media !== undefined && (!Array.isArray(snapshot.media) || snapshot.media.some(media => !validMediaMetadata(media))
    || new Set(snapshot.media.map(media => media.id)).size !== snapshot.media.length)) throw new Error('Invalid snapshot media.');
  for (const round of snapshot.rounds) if (round.artMediaId != null && !snapshot.media?.some(media => media.id === round.artMediaId && media.kind === 'image')) throw new Error('Invalid round art.');
  for (const round of snapshot.rounds) for (const question of round.questions) {
    for (const ref of question.media ?? []) {
      const media = snapshot.media?.find(media => media.id === ref.mediaId);
      if (!media || (ref.playBeforeTimer && media.kind === 'image')) throw new Error('Invalid snapshot media reference.');
    }
    for (const pair of question.pairs ?? []) for (const side of [pair.left, pair.right]) {
      if (side.kind === 'image' && !snapshot.media?.some(media => media.id === side.mediaId && media.kind === 'image')) throw new Error('Invalid snapshot image reference.');
    }
  }
  return snapshot;
}

// Start and portable export read the editor tree. Explicit fields exclude editor metadata/FKs.
export function readEditableQuizTree(db: DatabaseSync, quizId: string): GameSnapshot {
  const quiz = getQuiz(db, quizId);
  if (!quiz) throw new Error('Quiz not found.');
  const snapshot: GameSnapshot = {
    schemaVersion: 1, title: quiz.title, themeId: quiz.themeId,
    defaultAnswerTimeSeconds: quiz.defaultAnswerTimeSeconds, shuffleAnswers: quiz.shuffleAnswers,
    media: listMedia(db, quizId).map(({ quizId: _owner, ...media }) => media),
    rounds: listRounds(db, quizId).map(round => ({
      artMediaId: round.artMediaId ?? null, id: round.id, titleRu: round.titleRu, titleEn: round.titleEn,
      descriptionRu: round.descriptionRu, descriptionEn: round.descriptionEn,
      ...(round.isTiebreak ? { isTiebreak: true } : {}), showLeaderboardAfter: round.showLeaderboardAfter, position: round.position,
      questions: listQuestions(db, round.id).map(question => ({
        explanationRu: question.explanationRu, explanationEn: question.explanationEn, media: question.media, id: question.id, type: question.type, textRu: question.textRu, textEn: question.textEn,
        points: question.points, answerTimeSeconds: question.answerTimeSeconds,
        showOptionsOnScreen: question.showOptionsOnScreen, showCorrectCount: question.showCorrectCount, position: question.position,
        ...(question.type === 'matching' ? { pairs: listPairs(db, question.id).map(pair => ({
          id: pair.id, left: pair.left, right: pair.right, position: pair.position,
        })) } : {}),
        options: (question.type === 'matching' ? [] : listOptions(db, question.id)).map(option => ({
          id: option.id, textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect, position: option.position,
        })),
      })),
    })),
  };
  return snapshot;
}

export function createGameSnapshot(db: DatabaseSync, quizId: string): GameSnapshot {
  return parseGameSnapshot(JSON.stringify(readEditableQuizTree(db, quizId)));
}

// Internal gameplay boundary: reads only the durable snapshot, including after source deletion.
// Never send this object to Player HTTP/socket clients: it contains correct answers.
export function getGameSnapshot(db: DatabaseSync, sessionId: string): GameSnapshot | null {
  const row = db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(sessionId);
  return row?.snapshot_json == null ? null : parseGameSnapshot(String(row.snapshot_json));
}

// Navigation indexes address the ordered immutable snapshot, never editor IDs.
export function currentContent(db: DatabaseSync, roomId: string) {
  const navigation = db.prepare('SELECT current_round_index, current_question_index FROM game_sessions WHERE id = ?').get(roomId);
  const snapshot = getGameSnapshot(db, roomId);
  if (!navigation || !snapshot || navigation.current_round_index === null) throw new Error('Invalid game navigation.');
  const roundIndex = Number(navigation.current_round_index);
  const round = snapshot.rounds[roundIndex];
  if (!round) throw new Error('Current round not found.');
  const questionIndex = navigation.current_question_index === null ? null : Number(navigation.current_question_index);
  return { snapshot, round, roundIndex, questionIndex };
}
