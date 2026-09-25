import express, { type NextFunction, type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createQuiz, deleteQuiz, getQuiz, listQuizzes, updateQuiz, validateQuizChanges } from './quizzes.js';
import { createRound, deleteRound, listRounds, reorderRounds, updateRound, validateRoundChanges } from './rounds.js';

export function createApp(db: DatabaseSync) {
  const app = express();
  app.use(express.json());

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
  app.get('/api/quizzes/:id', (request, response) => {
    const quiz = getQuiz(db, request.params.id);
    if (!quiz) return response.status(404).json({ error: 'Quiz not found.' });
    return response.json(quiz);
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

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Invalid JSON.' });
    }
    return next(error);
  });

  return app;
}
