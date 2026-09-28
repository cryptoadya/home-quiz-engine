import { ThemeSurface } from './themes/ThemeSurface';
import { Countdown } from './Countdown';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useLobby, type NavigationAction } from './lobby';
import { RoundIntroContent, QuestionContent, BoundaryContent } from './GameContent';

export function Host() {
  const { roomId } = useParams();
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

  async function close() {
    if (!window.confirm('Close this room and release its code?')) return;
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

  return <ThemeSurface themeId={room?.themeId}>
    <h1>Host</h1>
    <Link to="/admin">Quiz list</Link>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!room && !error && !loadError && <p>Loading room...</p>}
    {room && <>
      <h2>{room.quizTitle}</h2>
      {room.isTest && <p><strong>Тестовая игра / Test Game</strong></p>}
      <Link to={`/screen/${room.id}`}>Open Screen</Link>
      <p>{connected ? 'Connected' : 'Reconnecting…'}</p>
      <p>Players: {state?.players?.length ?? 0} / 30</p>
      <ul>{state?.players?.map(player => <li key={player.id}>{player.name} — {player.language.toUpperCase()}</li>)}</ul>
      <p>Room code: <strong>{room.code}</strong></p>
      <p>State: <span>{room.state.toLowerCase().split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')}</span></p>
      {!room.closedAt && ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'].includes(room.state) &&
        <button onClick={() => void start('pause')} disabled={busy}>Pause</button>}
      {!room.closedAt && room.state === 'PAUSED' && <section className="game-content">
        <p>Game paused.</p>
        {state?.game?.state === 'PAUSED' && state.game.content && 'questionId' in state.game.content && <QuestionContent question={state.game.content as import('./lobby').CurrentQuestion} host mediaBusy />}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' && <>
          <p>{state.game.disconnectedPlayer?.name} disconnected.</p>
          <p role="status">{state.game.disconnectedPlayer?.present ? `${state.game.disconnectedPlayer.name} is back — Host can resume with Wait for Player.` : 'Waiting for Player to reconnect…'}</p>
        </>}
        {state?.game?.state === 'PAUSED' && <p>Paused from: {state.game.pausedFromState.toLowerCase().replaceAll('_', ' ')}</p>}
        {state?.game?.state === 'PAUSED' && state.game.reason === 'player_disconnect' ? <>
          <button onClick={() => void start('wait-for-player')} disabled={busy || !state.game.disconnectedPlayer?.present}>Wait for Player</button>
          <button onClick={() => void start('continue-without-player')} disabled={busy}>Continue Without Player</button>
        </> : <button onClick={() => void start('resume')} disabled={busy}>Resume</button>}
      </section>}
      {!room.closedAt && room.state === 'LOBBY' && Boolean(state?.players?.length) &&
        <button onClick={() => void start()} disabled={busy}>Start Game</button>}
      {!room.closedAt && state?.game?.state === 'ROUND_INTRO' && <section className="game-content">
        <RoundIntroContent round={state.game} />
        <p>Questions: {state.game.questionCount}</p>
        <button onClick={() => void start('start-round')} disabled={busy}>Start Round</button>
      </section>}
      {!room.closedAt && (state?.game?.state === 'QUESTION' || state?.game?.state === 'ANSWERING' || state?.game?.state === 'ANSWER_REVEAL') && <section className="game-content">
        <QuestionContent question={state.game} host mediaBusy={busy} onMediaControl={(id, action) => void controlMedia(id, action)} />
        <p>Points: {state.game.points}</p>
        <p>Answer time: {state.game.answerTimeSeconds} seconds</p>
        {state.game.state === 'QUESTION' && !state.game.preTimer && <button onClick={() => void start('start-question')} disabled={busy}>Start Question</button>}
        {state.game.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} />}
      </section>}
      {!room.closedAt && state?.game && ('nextAction' in state.game) && <>
        {['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.game.state) && <section className="game-content"><BoundaryContent game={state.game as import('./lobby').GameBoundary} /></section>}
        {state.game.nextAction && <button onClick={() => void start((state.game as { nextAction: NavigationAction }).nextAction)} disabled={busy}>{state.game.nextAction === 'next'
          ? ('questionNumber' in state.game && state.game.questionNumber < state.game.questionCount ? 'Next Question' : 'Next')
          : { 'show-leaderboard': 'Show Leaderboard', 'next-round': 'Next Round', 'final-results': 'Final Results', 'show-winner': 'Show Winner' }[state.game.nextAction]}</button>}
      </>}
      {room.closedAt ? <p role="status">Room closed</p> : <button onClick={() => void close()} disabled={busy}>Close room</button>}
    </>}
  </ThemeSurface>;
}
