import { request as api } from './request';
import { hostError, hostHint, hostPhases } from './host-messages';
import { ThemeSurface } from './themes/ThemeSurface';
import { Countdown } from './Countdown';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useLobby, type NavigationAction } from './lobby';
import { RoundIntroContent, QuestionContent, BoundaryContent } from './GameContent';

export function Host({ roomId: resolvedId }: { roomId?: string } = {}) {
  const params = useParams();
  const roomId = resolvedId ?? params.roomId;
  const { state, refresh, error: loadError, connected } = useLobby(roomId, 'host');
  const room = state?.room;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(action: 'start' | 'start-round' | 'start-question' | NavigationAction | 'pause' | 'resume' | 'wait-for-player' | 'continue-without-player' = 'start') {
    if (action === 'start' && !window.confirm('Начать игру? Состав игроков и содержание викторины будут зафиксированы.')) return;
    if (action === 'continue-without-player') {
      const name = state?.game?.state === 'PAUSED' ? state.game.disconnectedPlayer?.name : 'Игрок';
      if (!window.confirm(`Продолжить без игрока ${name}? За этот вопрос он получит 0 очков и сможет вернуться со следующего вопроса.`)) return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/rooms/${roomId}/${action}`, { method: 'POST' });
      await refresh();
    } catch (cause) { setError(hostError(cause)); }
    finally { setBusy(false); }
  }

  async function controlMedia(mediaId: string, action: import('./lobby').MediaAction) {
    if (!state?.game || !('questionId' in state.game)) return;
    setBusy(true); setError('');
    try {
      await api(`/api/rooms/${roomId}/media/${mediaId}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: state.game.questionId }),
      });
      await refresh();
    } catch (cause) { setError(hostError(cause)); }
    finally { setBusy(false); }
  }

  async function kick(player: { id: string; name: string }) {
    if (!window.confirm(`Удалить игрока ${player.name}? Он исчезнет из состава и таблицы результатов и не сможет подключиться снова под этой личностью.`)) return;
    setBusy(true); setError('');
    try {
      await api(`/api/rooms/${roomId}/players/${player.id}/kick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
      });
      await refresh();
    } catch (cause) { setError(hostError(cause)); }
    finally { setBusy(false); }
  }

  const gameInProgress = !!room && !['LOBBY', 'WINNER_SCREEN'].includes(room.state);
  async function close() {
    if (!window.confirm(gameInProgress ? 'Завершить игру и закрыть комнату? Игроки больше не смогут отвечать.' : 'Закрыть комнату и освободить её код?')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/rooms/${roomId}/close`, { method: 'POST' });
      await refresh();
    } catch (cause) { setError(hostError(cause)); }
    finally { setBusy(false); }
  }

  let primaryAction: Parameters<typeof start>[0] | undefined;
  let primaryLabel = '';
  let primaryDisabled = busy;
  if (room && !room.closedAt) {
    const game = state?.game;
    if (room.state === 'LOBBY' && state?.players?.length) { primaryAction = 'start'; primaryLabel = 'Начать игру'; }
    else if (game?.state === 'ROUND_INTRO') { primaryAction = 'start-round'; primaryLabel = 'Начать раунд'; }
    else if (game?.state === 'QUESTION' && !game.preTimer) { primaryAction = 'start-question'; primaryLabel = 'Начать вопрос'; }
    else if (room.state === 'PAUSED') {
      const waiting = game?.state === 'PAUSED' && game.reason === 'player_disconnect';
      primaryAction = waiting ? 'wait-for-player' : 'resume';
      primaryLabel = waiting ? 'Продолжить с игроком' : 'Продолжить';
      primaryDisabled ||= Boolean(waiting && !game.disconnectedPlayer?.present);
    } else if (game && 'nextAction' in game && game.nextAction) {
      primaryAction = game.nextAction;
      primaryLabel = game.nextAction === 'next'
        ? ('questionNumber' in game && game.questionNumber < game.questionCount ? 'Следующий вопрос' : 'Далее')
        : { 'show-leaderboard': 'Показать результаты', 'next-round': 'Следующий раунд', 'final-results': 'Итоги игры', 'show-winner': 'Показать победителей', 'start-tiebreak': 'Определить победителя' }[game.nextAction];
    }
  }

  return <ThemeSurface themeId={room?.themeId} className="host" data-phase={room?.closedAt ? 'CLOSED' : room?.state}>
    <header className="app-masthead"><div><span className="wordmark">Home Quiz</span><h1>Ведущий</h1></div><Link to="/admin">Список викторин</Link></header>
    {(error || loadError) && <p role="alert">{error || hostError(new Error(loadError))}</p>}
    {!room && !error && !loadError && <p>Загрузка комнаты…</p>}
    {room && <>
      <section className="host-overview"><h2>{room.quizTitle}</h2>
      {(room.closedAt || room.state !== 'LOBBY') && <Link to={`/screen/${room.closedAt ? room.id : room.code}`}>Открыть Screen</Link>}
      <p className="connection-chip" data-connected={connected}>{connected ? 'Подключено' : 'Переподключение…'}</p>
      <p>Игроков: {state?.players?.length ?? 0} / 30</p>
      {!state?.players?.length && <p role="status">Пока нет игроков. Попросите гостей сканировать QR на Screen или ввести код комнаты.</p>}
      <p>Код комнаты: <strong className="host-room-code">{room.code}</strong></p>
      {room.state !== 'LOBBY' && <p>Этап: <span className="phase-chip">{hostPhases[room.state]}</span></p>}
      {state && <p className="host-hint">{hostHint(state)}</p>}
      </section>
      <section className="host-controls" aria-label="Game controls">
      {primaryAction && <button className="host-primary-action" onClick={() => void start(primaryAction)} disabled={primaryDisabled}>{primaryLabel}</button>}
      {!room.closedAt && state?.game?.state === 'FINAL_RESULTS' && state.game.canStartTiebreak && <button className="host-primary-action" disabled={busy} onClick={() => void start('start-tiebreak')}>Определить победителя</button>}
      {room.tiebreak && <p role="status">{room.tiebreak.completed ? (room.tiebreak.contenderIds.length === 1 ? 'Победитель определён' : 'Допвопросы закончились: совместная победа') : `Допвопросы · Осталось: ${room.tiebreak.contenderIds.length}`}</p>}
      {!room.closedAt && ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'].includes(room.state) &&
        <div className="host-secondary-actions"><button className="subtle" onClick={() => void start('pause')} disabled={busy}>Пауза</button></div>}
      {!room.closedAt && room.state === 'PAUSED' && <section className="game-content">
        <p className="state-notice paused">Игра приостановлена.</p>
        {state?.game?.state === 'PAUSED' && state.game.content?.state === 'ROUND_INTRO' && <><RoundIntroContent round={state.game.content} /><p>Вопросов: {state.game.content.questionCount}</p></>}
        {state?.game?.state === 'PAUSED' && state.game.content && 'questionId' in state.game.content && <QuestionContent question={state.game.content as import('./lobby').CurrentQuestion} host mediaBusy />}
        {state?.game?.state === 'PAUSED' && state.game.content && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'].includes(state.game.content.state) && <BoundaryContent game={state.game.content as import('./lobby').GameBoundary} />}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' && <>
          <p>{state.game.disconnectedPlayer?.name} потерял(а) связь.</p>
          <p role="status">{state.game.disconnectedPlayer?.present ? `${state.game.disconnectedPlayer.name} снова подключён(а). Нажмите «Продолжить с игроком».` : 'Ожидаем возвращения игрока…'}</p>
        </>}
        {state?.game?.state === 'PAUSED' && <p>До паузы: {hostPhases[state.game.pausedFromState]}</p>}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' && <div className="host-secondary-actions">
          <button className="subtle danger" onClick={() => void start('continue-without-player')} disabled={busy}>Продолжить без игрока</button>
        </div>}
      </section>}
      {!room.closedAt && state?.game?.state === 'ROUND_INTRO' && <section className="game-content">
        <RoundIntroContent round={state.game} />
        <p>Вопросов: {state.game.questionCount}</p>
      </section>}
      {!room.closedAt && (state?.game?.state === 'QUESTION' || state?.game?.state === 'ANSWERING' || state?.game?.state === 'ANSWER_REVEAL') && <section className="game-content">
        <QuestionContent question={state.game} host mediaBusy={busy} onMediaControl={(id, action) => void controlMedia(id, action)} />
        <p>Очков: {state.game.points}</p>
        <p>Время на ответ: {state.game.answerTimeSeconds} сек.</p>
        {state.game.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} language="ru" />}
      </section>}
      {!room.closedAt && state?.game && ('nextAction' in state.game) && <>
        {['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.game.state) && <section className="game-content"><BoundaryContent game={state.game as import('./lobby').GameBoundary} /></section>}
      </>}
      </section>
      <section className="host-roster-section" aria-label="Players">
      <ul className="host-roster">{state?.players?.map(player => <li key={player.id} data-present={player.present}>
        <span>{player.name} — {player.language.toUpperCase()}{player.present !== undefined && ` — ${player.present ? 'На связи' : 'Нет связи'}`}</span>
        {!room.closedAt && !room.tiebreak && !['FINAL_RESULTS', 'WINNER_SCREEN'].includes(room.state) && !(state?.game?.state === 'PAUSED' && state.game.pausedFromState === 'FINAL_RESULTS') &&
          <button className="subtle danger" aria-label={`Удалить игрока ${player.name}`} disabled={busy} onClick={() => void kick(player)}>Удалить</button>}
      </li>)}</ul>
      </section>
      <footer className="host-danger">
      {room.closedAt ? <p role="status">Комната закрыта</p> : <button className="subtle danger" onClick={() => void close()} disabled={busy}>{gameInProgress ? 'Завершить игру' : 'Закрыть комнату'}</button>}
      </footer>
    </>}
  </ThemeSurface>;
}
