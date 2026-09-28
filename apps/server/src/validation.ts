import { validMediaReferences, getMedia, mediaAvailable, referencesError } from './media.js';
import { listPairs, validMatchingSide } from './matching.js';
import { DatabaseSync } from 'node:sqlite';
import { listOptions, listQuestions } from './questions.js';
import { getQuiz } from './quizzes.js';
import { listRounds } from './rounds.js';

export type ValidationProblem = {
  code: string;
  message: string;
  roundId?: string;
  questionId?: string;
  optionId?: string;
  pairId?: string;
};

export type QuizValidation = { ready: boolean; problems: ValidationProblem[] };

// Returns null only when the quiz does not exist. Drafts always get a result.
export function validateQuizReadiness(db: DatabaseSync, quizId: string): QuizValidation | null {
  const quiz = getQuiz(db, quizId);
  if (!quiz) return null;

  const problems: ValidationProblem[] = [];
  const add = (code: string, message: string, location: Omit<ValidationProblem, 'code' | 'message'> = {}) => {
    problems.push({ code, message, ...location });
  };
  if (!quiz.title.trim() || quiz.title.trim().length > 100) add('QUIZ_TITLE_INVALID', 'Quiz title must be 1–100 characters');
  if (!Number.isInteger(quiz.defaultAnswerTimeSeconds) || quiz.defaultAnswerTimeSeconds < 1 || quiz.defaultAnswerTimeSeconds > 3600) {
    add('QUIZ_TIMER_INVALID', 'Quiz answer time must be 1–3600 seconds');
  }

  const rounds = listRounds(db, quizId);
  if (rounds.length === 0) add('QUIZ_NO_ROUNDS', 'Quiz has no rounds');
  for (const round of rounds) {
    const roundName = round.titleEn.trim() || round.titleRu.trim() || `Round ${round.position + 1}`;
    const roundLocation = { roundId: round.id };
    if (!round.titleRu.trim() || round.titleRu.trim().length > 100) add('ROUND_TITLE_RU_INVALID', `Round “${roundName}” needs a Russian title of 1–100 characters`, roundLocation);
    if (!round.titleEn.trim() || round.titleEn.trim().length > 100) add('ROUND_TITLE_EN_INVALID', `Round “${roundName}” needs an English title of 1–100 characters`, roundLocation);
    if (round.artMediaId && (getMedia(db, quizId, round.artMediaId)?.kind !== 'image' || !mediaAvailable(db, quizId, round.artMediaId))) add('ROUND_ART_MISSING', 'Round art needs an available quiz-owned image', roundLocation);
    if (Boolean(round.descriptionRu.trim()) !== Boolean(round.descriptionEn.trim())) {
      add('ROUND_DESCRIPTION_INCOMPLETE', `Round “${roundName}” needs its description in both languages`, roundLocation);
    }

    const questions = listQuestions(db, round.id);
    if (questions.length === 0) add('ROUND_NO_QUESTIONS', `Round “${roundName}” has no questions`, roundLocation);
    for (const [questionIndex, question] of questions.entries()) {
      const label = `Question ${questionIndex + 1}`;
      const location = { roundId: round.id, questionId: question.id };
      if (question.type !== 'single_choice' && question.type !== 'yes_no' && question.type !== 'multiple_choice' && question.type !== 'matching') add('QUESTION_TYPE_UNSUPPORTED', `${label} must be Single Choice, Yes / No, Multiple Choice or Matching`, location);
      const mediaError = validMediaReferences(question.media) ? referencesError(db, quizId, question.media) : 'Invalid media reference structure.';
      if (mediaError) add('QUESTION_MEDIA_MISSING', `${label}: ${mediaError}`, location);
      for (const [language, value] of [['RU', question.textRu], ['EN', question.textEn]] as const) {
        if (!value.trim() && (question.textRu.trim() || question.textEn.trim() || (!Array.isArray(question.media) || question.media.length === 0))) add(`QUESTION_TEXT_${language}_MISSING`, `${label} is missing ${language === 'RU' ? 'Russian' : 'English'} text`, location);
        else if (value.length > 5000) add(`QUESTION_TEXT_${language}_TOO_LONG`, `${label} ${language === 'RU' ? 'Russian' : 'English'} text exceeds 5000 characters`, location);
      }
      if (Boolean(question.explanationRu.trim()) !== Boolean(question.explanationEn.trim()) || question.explanationRu.length > 5000 || question.explanationEn.length > 5000) add('EXPLANATION_INCOMPLETE', `${label} needs explanations in both languages, at most 5000 characters each`, location);
      if (!Number.isSafeInteger(question.points) || question.points < 1) add('QUESTION_POINTS_INVALID', `${label} needs a positive whole-number point value`, location);
      if (question.answerTimeSeconds !== null && (!Number.isInteger(question.answerTimeSeconds) || question.answerTimeSeconds < 1 || question.answerTimeSeconds > 3600)) {
        add('QUESTION_TIMER_INVALID', `${label} answer time must be 1–3600 seconds`, location);
      }

      if (question.type === 'matching') {
        const pairs = listPairs(db, question.id);
        if (pairs.length < 2) add('MATCHING_TOO_FEW_PAIRS', `${label} needs at least 2 complete pairs`, location);
        for (const [index, pair] of pairs.entries()) {
          for (const side of ['left', 'right'] as const) {
            if (!validMatchingSide(pair[side], true)) add('MATCHING_SIDE_INCOMPLETE', `Pair ${index + 1} ${side} in ${label} needs bilingual text or an image reference`, { ...location, pairId: pair.id });
            const item = pair[side];
            if (item?.kind === 'image' && (!mediaAvailable(db, quizId, item.mediaId) || getMedia(db, quizId, item.mediaId)?.kind !== 'image')) add('MATCHING_MEDIA_MISSING', `Pair ${index + 1} ${side} in ${label} needs an available quiz-owned image`, { ...location, pairId: pair.id });
          }
        }
        continue;
      }
      const options = listOptions(db, question.id);
      if (question.type === 'yes_no' && options.length !== 2) add('YES_NO_OPTION_COUNT', `${label} (Yes / No) needs exactly 2 answer options`, location);
      if (question.type !== 'yes_no' && options.length < 2) add(`${question.type.toUpperCase()}_TOO_FEW_OPTIONS`, `${label} needs at least 2 answer options`, location);
      if (question.type !== 'yes_no' && options.length > 10) add(`${question.type.toUpperCase()}_TOO_MANY_OPTIONS`, `${label} has more than 10 answer options`, location);
      if (question.type === 'multiple_choice' && options.filter(option => option.isCorrect).length < 2) add('MULTIPLE_CHOICE_CORRECT_COUNT', `${label} must have at least 2 correct answers`, location);
      if (question.type !== 'multiple_choice' && options.filter((option) => option.isCorrect).length !== 1) add(question.type === 'yes_no' ? 'YES_NO_CORRECT_COUNT' : 'SINGLE_CHOICE_CORRECT_COUNT', `${label} must have exactly 1 correct answer`, location);
      for (const [optionIndex, option] of options.entries()) {
        const optionLocation = { ...location, optionId: option.id };
        for (const [language, value] of [['RU', option.textRu], ['EN', option.textEn]] as const) {
          const name = language === 'RU' ? 'Russian' : 'English';
          if (!value.trim()) add(`OPTION_TEXT_${language}_MISSING`, `Option ${optionIndex + 1} in ${label} is missing ${name} text`, optionLocation);
          else if (value.length > 500) add(`OPTION_TEXT_${language}_TOO_LONG`, `Option ${optionIndex + 1} in ${label} exceeds 500 ${name} characters`, optionLocation);
        }
      }
    }
  }
  return { ready: problems.length === 0, problems };
}
