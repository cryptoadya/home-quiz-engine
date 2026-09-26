import { Countdown } from './Countdown';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useLobby } from './lobby';
import { RoundIntroContent, QuestionContent } from './GameContent';

export function Host() {
  const { roomId } = useParams();
  const { state, refresh, error: loadError, connected } = useLobby(roomId, 'host');
  const room = state?.room;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(action: 'start' | 'start-round' | 'start-question' = 'start') {
    if (action === 'start' && !window.confirm('Start game? The player list and quiz content will be locked.')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/${action}`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not start game.');
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

  return <main>
    <h1>Host</h1>
    <Link to="/admin">Quiz list</Link>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!room && !error && !loadError && <p>Loading room...</p>}
    {room && <>
      <h2>{room.quizTitle}</h2>
      <Link to={`/screen/${room.id}`}>Open Screen</Link>
      <p>{connected ? 'Connected' : 'Reconnecting…'}</p>
      <p>Players: {state?.players?.length ?? 0} / 30</p>
      <ul>{state?.players?.map(player => <li key={player.id}>{player.name} — {player.language.toUpperCase()}</li>)}</ul>
      <p>Room code: <strong>{room.code}</strong></p>
      <p>State: <span>{room.state === 'ROUND_INTRO' ? 'Round Intro' : room.state === 'QUESTION' ? 'Question' : room.state === 'ANSWERING' ? 'Answering' : 'Lobby'}</span></p>
      {!room.closedAt && room.state === 'LOBBY' && Boolean(state?.players?.length) &&
        <button onClick={() => void start()} disabled={busy}>Start Game</button>}
      {!room.closedAt && state?.game?.state === 'ROUND_INTRO' && <section className="game-content">
        <RoundIntroContent round={state.game} />
        <p>Questions: {state.game.questionCount}</p>
        <button onClick={() => void start('start-round')} disabled={busy}>Start Round</button>
      </section>}
      {!room.closedAt && (state?.game?.state === 'QUESTION' || state?.game?.state === 'ANSWERING') && <section className="game-content">
        <QuestionContent question={state.game} host />
        <p>Points: {state.game.points}</p>
        <p>Answer time: {state.game.answerTimeSeconds} seconds</p>
        {state.game.state === 'QUESTION' && <button onClick={() => void start('start-question')} disabled={busy}>Start Question</button>}
        {state.game.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} />}
      </section>}
      {room.closedAt ? <p role="status">Room closed</p> : <button onClick={() => void close()} disabled={busy}>Close room</button>}
    </>}
  </main>;
}
