import express, { type NextFunction, type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createQuiz, deleteQuiz, getQuiz, listQuizzes, updateQuiz, validateQuizChanges } from './quizzes.js';
import { createRound, deleteRound, listRounds, reorderRounds, updateRound, validateRoundChanges } from './rounds.js';
import { createQuestion, deleteQuestion, getQuestion, listQuestions, reorderQuestions, updateQuestion, validateQuestionChanges,
  createOption, deleteOption, getOption, listOptions, reorderOptions, selectCorrectOption, updateOption, validateOptionChanges } from './questions.js';
import { getRound } from './rounds.js';
import { validateQuizReadiness } from './validation.js';

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
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length)) return response.status(400).json({ error: 'Create question does not accept fields.' });
    return response.status(201).json(createQuestion(db, request.params.roundId));
  });
  app.put(`${roundPath}/order`, (request, response) => {
    if (!getRound(db, request.params.quizId, request.params.roundId)) return response.status(404).json({ error: 'Round not found in quiz.' });
    const questions = reorderQuestions(db, request.params.roundId, request.body?.ids);
    return questions ? response.json(questions) : response.status(400).json({ error: 'Order must include every question exactly once.' });
  });
  app.put(questionPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    const result = validateQuestionChanges(request.body);
    return 'error' in result ? response.status(400).json(result) : response.json(updateQuestion(db, request.params.roundId, request.params.questionId, result.changes));
  });
  app.delete(questionPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    deleteQuestion(db, request.params.roundId, request.params.questionId);
    return response.status(204).end();
  });
  app.get(optionsPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    return response.json(listOptions(db, request.params.questionId));
  });
  app.post(optionsPath, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId)) return response.status(404).json({ error: 'Question not found in round.' });
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length)) return response.status(400).json({ error: 'Create option does not accept fields.' });
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
    return response.json(selectCorrectOption(db, request.params.questionId, request.params.optionId));
  });
  app.put(`${optionsPath}/:optionId`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId) || !getOption(db, request.params.questionId, request.params.optionId)) return response.status(404).json({ error: 'Option not found in question.' });
    const result = validateOptionChanges(request.body);
    return 'error' in result ? response.status(400).json(result) : response.json(updateOption(db, request.params.questionId, request.params.optionId, result.changes));
  });
  app.delete(`${optionsPath}/:optionId`, (request, response) => {
    if (!getQuestion(db, request.params.quizId, request.params.roundId, request.params.questionId) || !getOption(db, request.params.questionId, request.params.optionId)) return response.status(404).json({ error: 'Option not found in question.' });
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
