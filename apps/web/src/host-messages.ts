import type { LobbyState, Room } from './lobby';
import { RequestError } from './request';

export const hostPhases: Record<Room['state'], string> = {
  LOBBY: 'Ожидание игроков', ROUND_INTRO: 'Начало раунда', QUESTION: 'Подготовка вопроса',
  ANSWERING: 'Игроки отвечают', ANSWER_REVEAL: 'Показ ответа', ROUND_END: 'Раунд завершён',
  LEADERBOARD: 'Таблица лидеров', FINAL_RESULTS: 'Итоги игры', WINNER_SCREEN: 'Победители', PAUSED: 'Пауза',
};

export function hostHint(state: LobbyState): string {
  if (state.room.closedAt) return 'Комната закрыта. Для новой игры откройте лобби в Admin.';
  const game = state.game;
  switch (state.room.state) {
    case 'LOBBY': return 'Дождитесь подключения гостей и начните игру. После старта новые игроки присоединиться не смогут.';
    case 'ROUND_INTRO': return 'Представьте раунд, затем нажмите «Начать раунд».';
    case 'QUESTION': return game?.state === 'QUESTION' && game.preTimer ? 'На Screen идёт обязательное медиа. После его завершения начнётся отсчёт времени.' : 'Вопрос пока виден только вам. Нажмите «Начать вопрос», когда будете готовы.';
    case 'ANSWERING': return game?.state === 'ANSWERING' && game.answers ? `Принято ${game.answers.answered} из ${game.answers.expected} ответов. Ответ откроется, когда все ответят или закончится время.` : 'Дождитесь ответов игроков или окончания времени.';
    case 'ANSWER_REVEAL': return 'Обсудите правильный ответ, затем продолжите игру.';
    case 'ROUND_END': return 'Раунд завершён. Продолжите к таблице лидеров или следующему этапу.';
    case 'LEADERBOARD': return 'Озвучьте результаты, затем переходите к следующему раунду или итогам игры.';
    case 'FINAL_RESULTS': return 'Покажите победителей. При ничьей можно использовать доступные дополнительные вопросы.';
    case 'WINNER_SCREEN': return 'Поздравьте победителей. Затем можно закрыть комнату.';
    case 'PAUSED': return game?.state === 'PAUSED' && game.reason === 'player_disconnect' ? 'Дождитесь возвращения игрока или продолжите без него: за этот вопрос он получит 0 очков.' : 'Игра приостановлена. Нажмите «Продолжить», когда будете готовы.';
  }
}

const errors: Record<string, string> = {
  'Room not found.': 'Комната не найдена. Проверьте код комнаты.',
  'Room is closed.': 'Комната уже закрыта. Откройте новое лобби в Admin.',
  'Game has already started.': 'Игра уже началась. Дождитесь обновления экрана.',
  'At least one active player is required.': 'Для начала игры нужен хотя бы один игрок.',
  'Quiz is not ready. Review the validation problems.': 'Викторина не готова. Исправьте ошибки в Admin.',
  'Player has not reconnected yet.': 'Игрок ещё не подключился. Дождитесь его возвращения или продолжите без него.',
  'Question has completed.': 'Вопрос уже завершён. Дождитесь обновления экрана.',
  'Use Wait for Player or Continue Without Player to resolve this pause.': 'Дождитесь игрока или выберите «Продолжить без игрока».',
  'Players cannot be removed after game completion or closure.': 'После завершения игры удалить игрока нельзя.',
  'Active player not found.': 'Игрок уже удалён или недоступен. Проверьте список участников.',
  'Only current pre-timer media can be controlled.': 'Сейчас можно управлять только текущим обязательным медиа.',
  'Current playable media not found.': 'Медиа текущего вопроса недоступно. Проверьте состояние Screen.',
};

export function hostError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (errors[message]) return errors[message];
  if (/[А-Яа-яЁё]/.test(message)) return message;
  if (cause instanceof RequestError && cause.status === 409) return 'Действие недоступно на текущем этапе. Дождитесь обновления экрана и повторите действие.';
  return 'Не удалось выполнить действие или обновить состояние. Проверьте соединение и повторите действие.';
}
