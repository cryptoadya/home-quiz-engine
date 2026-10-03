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
    if (action === 'start' && !window.confirm('Start game? The player list and quiz content will be locked.')) return;
    if (action === 'continue-without-player') {
      const name = state?.game?.state === 'PAUSED' ? state.game.disconnectedPlayer?.name : 'Player';
      if (!window.confirm(`Continue without ${name}? ${name} will receive 0 points for this question and can return for the next question.`)) return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/${action}`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not advance game.');
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function controlMedia(mediaId: string, action: import('./lobby').MediaAction) {
    if (!state?.game || !('questionId' in state.game)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/media/${mediaId}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: state.game.questionId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not control media.');
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function kick(player: { id: string; name: string }) {
    if (!window.confirm(`Kick ${player.name}? They will be removed from the roster and leaderboard and cannot reconnect as this player.`)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/players/${player.id}/kick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not kick player.');
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const gameInProgress = !!room && !['LOBBY', 'WINNER_SCREEN'].includes(room.state);
  async function close() {
    if (!window.confirm(gameInProgress ? 'End this game and close the room? Players will no longer be able to answer.' : 'Close this room and release its code?')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/close`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not close room.');
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  let primaryAction: Parameters<typeof start>[0] | undefined;
  let primaryLabel = '';
  let primaryDisabled = busy;
  if (room && !room.closedAt) {
    const game = state?.game;
    if (room.state === 'LOBBY' && state?.players?.length) { primaryAction = 'start'; primaryLabel = 'Start Game'; }
    else if (game?.state === 'ROUND_INTRO') { primaryAction = 'start-round'; primaryLabel = 'Start Round'; }
    else if (game?.state === 'QUESTION' && !game.preTimer) { primaryAction = 'start-question'; primaryLabel = 'Start Question'; }
    else if (room.state === 'PAUSED') {
      const waiting = game?.state === 'PAUSED' && game.reason === 'player_disconnect';
      primaryAction = waiting ? 'wait-for-player' : 'resume';
      primaryLabel = waiting ? 'Wait for Player' : 'Resume';
      primaryDisabled ||= Boolean(waiting && !game.disconnectedPlayer?.present);
    } else if (game && 'nextAction' in game && game.nextAction) {
      primaryAction = game.nextAction;
      primaryLabel = game.nextAction === 'next'
        ? ('questionNumber' in game && game.questionNumber < game.questionCount ? 'Next Question' : 'Next')
        : { 'show-leaderboard': 'Show Leaderboard', 'next-round': 'Next Round', 'final-results': 'Final Results', 'show-winner': 'Show Winner', 'start-tiebreak': 'Определить победителя / Start Tiebreak' }[game.nextAction];
    }
  }

  return <ThemeSurface themeId={room?.themeId} className="host" data-phase={room?.closedAt ? 'CLOSED' : room?.state}>
    <header className="app-masthead"><div><span className="wordmark">Home Quiz</span><h1>Host</h1></div><Link to="/admin">Quiz list</Link></header>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!room && !error && !loadError && <p>Loading room...</p>}
    {room && <>
      <section className="host-overview"><h2>{room.quizTitle}</h2>
      {room.isTest && <p className="test-banner"><strong>Тестовая игра / Test Game</strong></p>}
      {(room.closedAt || room.state !== 'LOBBY') && <Link to={`/screen/${room.closedAt ? room.id : room.code}`}>Open Screen</Link>}
      <p className="connection-chip" data-connected={connected}>{connected ? 'Connected' : 'Reconnecting…'}</p>
      <p>Players: {state?.players?.length ?? 0} / 30</p>
      {!state?.players?.length && <p role="status">No players. Ask guests to scan the Screen QR code or enter the room code.</p>}
      <p>Room code: <strong className="host-room-code">{room.code}</strong></p>
      {room.state !== 'LOBBY' && <p>State: <span className="phase-chip">{room.state.toLowerCase().split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')}</span></p>}
      </section>
      <section className="host-controls" aria-label="Game controls">
      {primaryAction && <button className="host-primary-action" onClick={() => void start(primaryAction)} disabled={primaryDisabled}>{primaryLabel}</button>}
      {!room.closedAt && state?.game?.state === 'FINAL_RESULTS' && state.game.canStartTiebreak && <button className="host-primary-action" disabled={busy} onClick={() => void start('start-tiebreak')}>Определить победителя / Start Tiebreak</button>}
      {room.tiebreak && <p role="status">{room.tiebreak.completed ? (room.tiebreak.contenderIds.length === 1 ? 'Победитель определён / Winner decided' : 'Допвопросы закончились: совместная победа / Reserve exhausted: shared win') : `Допвопросы / Tiebreak · Осталось / Remaining: ${room.tiebreak.contenderIds.length}`}</p>}
      {!room.closedAt && ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'].includes(room.state) &&
        <div className="host-secondary-actions"><button className="subtle" onClick={() => void start('pause')} disabled={busy}>Pause</button></div>}
      {!room.closedAt && room.state === 'PAUSED' && <section className="game-content">
        <p className="state-notice paused">Game paused.</p>
        {state?.game?.state === 'PAUSED' && state.game.content?.state === 'ROUND_INTRO' && <><RoundIntroContent round={state.game.content} /><p>Questions: {state.game.content.questionCount}</p></>}
        {state?.game?.state === 'PAUSED' && state.game.content && 'questionId' in state.game.content && <QuestionContent question={state.game.content as import('./lobby').CurrentQuestion} host mediaBusy />}
        {state?.game?.state === 'PAUSED' && state.game.content && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'].includes(state.game.content.state) && <BoundaryContent game={state.game.content as import('./lobby').GameBoundary} />}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' && <>
          <p>{state.game.disconnectedPlayer?.name} disconnected.</p>
          <p role="status">{state.game.disconnectedPlayer?.present ? `${state.game.disconnectedPlayer.name} is back — Host can resume with Wait for Player.` : 'Waiting for Player to reconnect…'}</p>
        </>}
        {state?.game?.state === 'PAUSED' && <p>Paused from: {state.game.pausedFromState.toLowerCase().replaceAll('_', ' ')}</p>}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' && <div className="host-secondary-actions">
          <button className="subtle danger" onClick={() => void start('continue-without-player')} disabled={busy}>Continue Without Player</button>
        </div>}
      </section>}
      {!room.closedAt && state?.game?.state === 'ROUND_INTRO' && <section className="game-content">
        <RoundIntroContent round={state.game} />
        <p>Questions: {state.game.questionCount}</p>
      </section>}
      {!room.closedAt && (state?.game?.state === 'QUESTION' || state?.game?.state === 'ANSWERING' || state?.game?.state === 'ANSWER_REVEAL') && <section className="game-content">
        <QuestionContent question={state.game} host mediaBusy={busy} onMediaControl={(id, action) => void controlMedia(id, action)} />
        <p>Points: {state.game.points}</p>
        <p>Answer time: {state.game.answerTimeSeconds} seconds</p>
        {state.game.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} />}
      </section>}
      {!room.closedAt && state?.game && ('nextAction' in state.game) && <>
        {['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.game.state) && <section className="game-content"><BoundaryContent game={state.game as import('./lobby').GameBoundary} /></section>}
      </>}
      </section>
      <section className="host-roster-section" aria-label="Players">
      <ul className="host-roster">{state?.players?.map(player => <li key={player.id} data-present={player.present}>
        <span>{player.name} — {player.language.toUpperCase()}{player.present !== undefined && ` — ${player.present ? 'Online' : 'Disconnected'}`}</span>
        {!room.closedAt && !room.tiebreak && !['FINAL_RESULTS', 'WINNER_SCREEN'].includes(room.state) && !(state?.game?.state === 'PAUSED' && state.game.pausedFromState === 'FINAL_RESULTS') &&
          <button className="subtle danger" aria-label={`Kick ${player.name}`} disabled={busy} onClick={() => void kick(player)}>Kick</button>}
      </li>)}</ul>
      </section>
      <footer className="host-danger">
      {room.closedAt ? <p role="status">Room closed</p> : <button className="subtle danger" onClick={() => void close()} disabled={busy}>{gameInProgress ? 'End Game' : 'Close room'}</button>}
      </footer>
    </>}
  </ThemeSurface>;
}
