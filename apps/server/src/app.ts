import { uploadFailure, deleteMedia, getMedia, listMedia, mediaAvailable, mediaFile, mediaUpload, persistUpload, referencesError } from './media.js';
import { createPair, deletePair, getPair, listPairs, reorderPairs, updatePair, validatePairChanges } from './matching.js';
import { pauseGame, resumeGame, waitForPlayer, continueWithoutPlayer, absentPlayerPresence, type PlayerPresenceChecker } from './pause.js';
import { navigate, type NavigationAction } from './navigation.js';
import { submitAnswer } from './answers.js';
import { getSurfaceState, getPlayerGame, startRound, startQuestion } from './game.js';
import { joinPlayer, reconnectPlayer, listPlayers } from './players.js';
import { createRoom, getRoom, getRoomByCode, closeRoom, startRoom } from './rooms.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createQuiz, deleteQuiz, duplicateQuiz, getQuiz, listQuizzes, updateQuiz, validateQuizChanges } from './quizzes.js';
import { createRound, deleteRound, listRounds, reorderRounds, updateRound, validateRoundChanges } from './rounds.js';
import { createQuestion, deleteQuestion, getQuestion, listQuestions, reorderQuestions, updateQuestion, validateQuestionChanges,
  createOption, deleteOption, getOption, listOptions, reorderOptions, selectCorrectOption, updateOption, validateOptionChanges } from './questions.js';
import { getRound } from './rounds.js';
import { validateQuizReadiness } from './validation.js';

export function createApp(db: DatabaseSync, lobbyChanged: (roomId: string) => void = () => {}, presence: PlayerPresenceChecker = absentPlayerPresence) {
  const app = express();
  app.use(express.json());

  const mediaPath = '/api/quizzes/:quizId/media';
  app.use(mediaPath, (request, response, next) => {
    if (!getQuiz(db, request.params.quizId)) return response.status(404).json({ error: 'Quiz not found.' });
    next();
  });
  app.get(mediaPath, (request, response) => response.json(listMedia(db, request.params.quizId)));
  app.post(mediaPath, (request, response) => {
    mediaUpload(db)(request, response, async error => {
      if (error) { const failure = uploadFailure(error); return response.status(failure.status).json({ error: failure.error }); }
      if (!request.file) return response.status(400).json({ error: 'Upload one file in the file field.' });
      try { return response.status(201).json(await persistUpload(db, request.params.quizId, request.file)); }
      catch (cause) { const failure = uploadFailure(cause); return response.status(failure.status).json({ error: failure.error }); }
    });
  });
  app.get(`${mediaPath}/:mediaId/content`, (request, response) => {
    const media = getMedia(db, request.params.quizId, request.params.mediaId);
    if (!media || !mediaAvailable(db, media.quizId, media.id)) return response.status(404).json({ error: 'Media not found.' });
    response.set('X-Content-Type-Options', 'nosniff');
    response.type(media.mimeType);
    return response.sendFile(mediaFile(db, media.quizId, media.id));
  });
  app.delete(`${mediaPath}/:mediaId`, (request, response) => deleteMedia(db, request.params.quizId, request.params.mediaId)
    ? response.status(204).end() : response.status(404).json({ error: 'Media not found.' }));

  app.post('/api/quizzes/:quizId/rooms', (request, response) => {
    const result = createRoom(db, request.params.quizId);
    if ('room' in result) return response.status(201).json(result.room);
    const { status, ...body } = result;
    return response.status(status).json(body);
  });
  app.get('/api/rooms/code/:code', (request, response) => {
    const room = getRoomByCode(db, request.params.code);
    return room ? response.json(room) : response.status(404).json({ error: 'Active room not found.' });
  });
  app.get('/api/rooms/:roomId', (request, response) => {
    const room = getRoom(db, request.params.roomId);
    return room ? response.json(room) : response.status(404).json({ error: 'Room not found.' });
  });
  app.get('/api/rooms/:roomId/lobby', (request, response) => {
    const room = getRoom(db, request.params.roomId);
    response.set('Cache-Control', 'no-store');
    return room ? response.json({ room, players: listPlayers(db, room.id) }) : response.status(404).json({ error: 'Room not found.' });
  });
  for (const audience of ['host', 'screen'] as const) {
    app.get(`/api/rooms/:roomId/game/${audience}`, (request, response) => {
      response.set('Cache-Control', 'no-store');
      const state = getSurfaceState(db, request.params.roomId, audience, Date.now(), presence);
      return state ? response.json(state) : response.status(404).json({ error: 'Room not found.' });
    });
  }
  for (const action of ['next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner'] satisfies NavigationAction[]) {
    app.post(`/api/rooms/:roomId/${action}`, (request, response) => {
      const result = navigate(db, request.params.roomId, action);
      if ('room' in result) {
        lobbyChanged(result.room.id);
        return response.json(result.room);
      }
      return response.status(result.status).json({ error: result.error });
    });
  }
  for (const [action, command] of [['pause', pauseGame], ['resume', resumeGame], ['wait-for-player', (db: DatabaseSync, roomId: string) => waitForPlayer(db, roomId, presence)], ['continue-without-player', continueWithoutPlayer]] as const) {
    app.post(`/api/rooms/:roomId/${action}`, (request, response) => {
      const result = command(db, request.params.roomId);
      if ('room' in result) {
        lobbyChanged(result.room.id);
        return response.json(result.room);
      }
      // An expired Pause still commits Reveal and must publish that transition.
      if (result.changed) lobbyChanged(request.params.roomId);
      return response.status(result.status).json({ error: result.error });
    });
  }
  app.post('/api/rooms/:roomId/start-question', (request, response) => {
    const result = startQuestion(db, request.params.roomId);
    if (result.room) {
      lobbyChanged(result.room.id);
      return response.json(result.room);
    }
    return response.status(result.status!).json({ error: result.error });
  });
  app.post('/api/rooms/:roomId/start-round', (request, response) => {
    const result = startRound(db, request.params.roomId);
    if (result.room) {
      lobbyChanged(result.room.id);
      return response.json(result.room);
    }
    return response.status(result.status!).json({ error: result.error });
  });
  app.post('/api/rooms/:roomId/start', (request, response) => {
    const result = startRoom(db, request.params.roomId);
    if ('room' in result) {
      lobbyChanged(result.room.id);
      return response.json(result.room);
    }
    const { status, ...body } = result;
    return response.status(status).json(body);
  });
  app.post('/api/rooms/:roomId/close', (request, response) => {
    const room = closeRoom(db, request.params.roomId);
    if (room) lobbyChanged(room.id);
    return room ? response.json(room) : response.status(404).json({ error: 'Room not found.' });
  });

  app.post('/api/rooms/code/:code/players', (request, response) => {
    const result = joinPlayer(db, request.params.code, request.body);
    response.set('Cache-Control', 'no-store');
    if ('status' in result) return response.status(result.status).json({ error: result.error });
    lobbyChanged(result.room.id);
    return response.status(201).json(result);
  });
  app.post('/api/rooms/:roomId/answers', (request, response) => {
    const result = submitAnswer(db, request.params.roomId, request.body);
    response.set('Cache-Control', 'no-store');
    if ('status' in result) {
      const { status, ...body } = result;
      return response.status(status).json(body);
    }
    if (result.inserted) lobbyChanged(request.params.roomId);
    return response.json(result.submission);
  });
  app.post('/api/rooms/:roomId/reconnect', (request, response) => {
    const result = reconnectPlayer(db, request.params.roomId, request.body?.token);
    response.set('Cache-Control', 'no-store');
    if ('status' in result) return response.status(result.status).json({ error: result.error });
    return response.json({ ...result, game: getPlayerGame(db, result.room.id, result.player.language, result.player.id) });
  });
  app.get('/api/rooms/:roomId/players', (request, response) => {
    const room = getRoom(db, request.params.roomId);
    if (!room || room.closedAt) return response.status(404).json({ error: 'Active room not found.' });
    return response.json(listPlayers(db, room.id));
  });

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/quizzes', (_request, response) => {
    response.json(listQuizzes(db));
  });
  app.post('/api/quizzes', (request, response) => {
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
      return response.status(400).json({ error: 'Create quiz does not accept settings.' });
    }
    response.status(201).json(createQuiz(db));
  });
  app.post('/api/quizzes/:id/duplicate', (request, response) => {
    const copy = duplicateQuiz(db, request.params.id);
    return copy ? response.status(201).json(copy) : response.status(404).json({ error: 'Quiz not found.' });
  });
  app.get('/api/quizzes/:id', (request, response) => {
    const quiz = getQuiz(db, request.params.id);
    if (!quiz) return response.status(404).json({ error: 'Quiz not found.' });
    return response.json(quiz);
  });
  app.get('/api/quizzes/:id/validation', (request, response) => {
    const result = validateQuizReadiness(db, request.params.id);
    return result ? response.json(result) : response.status(404).json({ error: 'Quiz not found.' });
  });
  app.put('/api/quizzes/:id', (request, response) => {
    const result = validateQuizChanges(request.body);
    if ('error' in result) return response.status(400).json(result);
    const quiz = updateQuiz(db, request.params.id, result.changes);
    if (!quiz) return response.status(404).json({ error: 'Quiz not found.' });
    return response.json(quiz);
  });
  app.delete('/api/quizzes/:id', (request, response) => {
    if (!deleteQuiz(db, request.params.id)) return response.status(404).json({ error: 'Quiz not found.' });
    return response.status(204).end();
  });

  app.get('/api/quizzes/:quizId/rounds', (request, response) => {
    if (!getQuiz(db, request.params.quizId)) return response.status(404).json({ error: 'Quiz not found.' });
    return response.json(listRounds(db, request.params.quizId));
  });
  app.post('/api/quizzes/:quizId/rounds', (request, response) => {
    if (!getQuiz(db, request.params.quizId)) return response.status(404).json({ error: 'Quiz not found.' });
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
      return response.status(400).json({ error: 'Create round does not accept fields.' });
    }
    return response.status(201).json(createRound(db, request.params.quizId));
  });
  app.put('/api/quizzes/:quizId/rounds/order', (request, response) => {
    if (!getQuiz(db, request.params.quizId)) return response.status(404).json({ error: 'Quiz not found.' });
    const rounds = reorderRounds(db, request.params.quizId, request.body?.ids);
    if (!rounds) return response.status(400).json({ error: 'Order must include every round exactly once.' });
    return response.json(rounds);
  });
  app.put('/api/quizzes/:quizId/rounds/:roundId', (request, response) => {
    const result = validateRoundChanges(request.body);
    if ('error' in result) return response.status(400).json(result);
    const round = updateRound(db, request.params.quizId, request.params.roundId, result.changes);
    if (!round) return response.status(404).json({ error: 'Round not found in quiz.' });
    return response.json(round);
  });
  app.delete('/api/quizzes/:quizId/rounds/:roundId', (request, response) => {
    if (!deleteRound(db, request.params.quizId, request.params.roundId)) return response.status(404).json({ error: 'Round not found in quiz.' });
    return response.status(204).end();
  });

  const roundPath = '/api/quizzes/:quizId/rounds/:roundId/questions';
  const questionPath = `${roundPath}/:questionId`;
  const optionsPath = `${questionPath}/options`;
  app.get(roundPath, (request, response) => {
    if (!getRound(db, request.params.quizId, request.params.roundId)) return response.status(404).json({ error: 'Round not found in quiz.' });
    return response.json(listQuestions(db, request.params.roundId));
  });
  app.post(roundPath, (request, response) => {
    if (!getRound(db, request.params.quizId, request.params.roundId)) return response.status(404).json({ error: 'Round not found in quiz.' });
    const body = request.body;
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some(key => key !== 'type') || (body.type !== undefined && body.type !== 'single_choice' && body.type !== 'yes_no' && body.type !== 'multiple_choice' && body.type !== 'matching'))) return response.status(400).json({ error: 'Create question accepts only type: single_choice, yes_no, multiple_choice or matching.' });
    return response.status(201).json(createQuestion(db, request.params.roundId, body?.type));
  });
  app.put(`${roundPath}/order`, (request, response) => {
    if (!getRound(db, request.params.quizId, request.params.roundId)) return response.status(404).json({ error: 'Round not found in quiz.' });
    const questions = reorderQuestions(db, request.params.roundId, request.body?.ids);
    return questions ? response.json(questions) : response.status(400).json({ error: 'Order must include every question exactly once.' });
  });
  app.put(questionPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    const result = validateQuestionChanges(request.body);
    if ('changes' in result && result.changes.media) {
      const error = referencesError(db, request.params.quizId, result.changes.media);
      if (error) return response.status(400).json({ error });
    }
    if (!('error' in result) && result.changes.type === 'yes_no' && getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'yes_no') {
      const options = listOptions(db, request.params.questionId);
      if (options.length !== 2 || options.filter(option => option.isCorrect).length !== 1) return response.status(400).json({ error: 'Yes / No needs exactly two options and one correct answer.' });
    }
    return 'error' in result ? response.status(400).json(result) : response.json(updateQuestion(db, request.params.roundId, request.params.questionId, result.changes));
  });
  app.delete(questionPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    deleteQuestion(db, request.params.roundId, request.params.questionId);
    return response.status(204).end();
  });
  // Authoring endpoints never allow inactive answer structures to be mutated.
  app.use(optionsPath, (request, response, next) => {
    if (getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'matching' && request.method !== 'GET') return response.status(409).json({ error: 'Matching uses pairs, not options.' });
    next();
  });
  const pairsPath = `${questionPath}/pairs`;
  app.use(pairsPath, (request, response, next) => {
    const question = getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId);
    if (!question) return response.status(404).json({ error: 'Question not found in round.' });
    if (question.type !== 'matching') return response.status(409).json({ error: 'Pairs belong to Matching questions.' });
    next();
  });
  app.get(pairsPath, (request, response) => response.json(listPairs(db, request.params.questionId)));
  app.post(pairsPath, (request, response) => {
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length)) return response.status(400).json({ error: 'Create pair does not accept fields.' });
    return response.status(201).json(createPair(db, request.params.questionId));
  });
  app.put(`${pairsPath}/order`, (request, response) => {
    const pairs = reorderPairs(db, request.params.questionId, request.body?.ids);
    return pairs ? response.json(pairs) : response.status(400).json({ error: 'Order must include every pair exactly once.' });
  });
  app.put(`${pairsPath}/:pairId`, (request, response) => {
    if (!getPair(db, request.params.questionId, request.params.pairId)) return response.status(404).json({ error: 'Pair not found in question.' });
    const result = validatePairChanges(request.body);
    if ('changes' in result) {
      for (const side of [result.changes.left, result.changes.right]) {
        if (side.kind === 'image' && (referencesError(db, request.params.quizId, [{ mediaId: side.mediaId, playBeforeTimer: false }])
          || getMedia(db, request.params.quizId, side.mediaId)?.kind !== 'image')) return response.status(400).json({ error: 'Matching requires a quiz-owned image.' });
      }
    }
    return 'error' in result ? response.status(400).json(result) : response.json(updatePair(db, request.params.questionId, request.params.pairId, result.changes));
  });
  app.delete(`${pairsPath}/:pairId`, (request, response) => {
    if (!getPair(db, request.params.questionId, request.params.pairId)) return response.status(404).json({ error: 'Pair not found in question.' });
    deletePair(db, request.params.questionId, request.params.pairId);
    return response.status(204).end();
  });
  app.get(optionsPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    return response.json(listOptions(db, request.params.questionId));
  });
  app.post(optionsPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length)) return response.status(400).json({ error: 'Create option does not accept fields.' });
    if (getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'yes_no') return response.status(400).json({ error: 'Yes / No has exactly two fixed options.' });
    if (listOptions(db, request.params.questionId).length >= 10) return response.status(400).json({ error: 'A question can have at most 10 options.' });
    return response.status(201).json(createOption(db, request.params.questionId));
  });
  app.put(`${optionsPath}/order`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    const options = reorderOptions(db, request.params.questionId, request.body?.ids);
    return options ? response.json(options) : response.status(400).json({ error: 'Order must include every option exactly once.' });
  });
  app.put(`${optionsPath}/:optionId/correct`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId) || !getOption(db, request.params.questionId, request.params.optionId)) return response.status(404).json({ error: 'Option not found in question.' });
    if (getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'yes_no' && listOptions(db, request.params.questionId).length !== 2) return response.status(400).json({ error: 'Yes / No needs exactly two options.' });
    if (getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'multiple_choice') return response.status(400).json({ error: 'Use option fields to toggle Multiple Choice correctness.' });
    return response.json(selectCorrectOption(db, request.params.questionId, request.params.optionId));
  });
  app.put(`${optionsPath}/:optionId`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId) || !getOption(db, request.params.questionId, request.params.optionId)) return response.status(404).json({ error: 'Option not found in question.' });
    const result = validateOptionChanges(request.body);
    if (!('error' in result) && getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'yes_no') {
      const correctCount = listOptions(db, request.params.questionId).filter(option => option.id === request.params.optionId ? result.changes.isCorrect : option.isCorrect).length;
      if (listOptions(db, request.params.questionId).length !== 2 || correctCount !== 1) return response.status(400).json({ error: 'Yes / No must have exactly one correct option. Use the correct-answer selector.' });
    }
    return 'error' in result ? response.status(400).json(result) : response.json(updateOption(db, request.params.questionId, request.params.optionId, result.changes));
  });
  app.delete(`${optionsPath}/:optionId`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId) || !getOption(db, request.params.questionId, request.params.optionId)) return response.status(404).json({ error: 'Option not found in question.' });
    if (getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)?.type === 'yes_no') return response.status(400).json({ error: 'Yes / No has exactly two fixed options.' });
    deleteOption(db, request.params.questionId, request.params.optionId);
    return response.status(204).end();
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Invalid JSON.' });
    }
    return next(error);
  });

  return app;
}
