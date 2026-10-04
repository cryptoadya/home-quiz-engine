import { ThemeSurface } from './themes/ThemeSurface';
import { Countdown } from './Countdown';
import { useParams } from 'react-router-dom';
import { PlayerJoinCode } from './PlayerJoinCode';
import { reachableOrigin, useShareOrigin } from './share-origin';
import { useLobby } from './lobby';
import { RoundIntroContent, QuestionContent, BoundaryContent } from './GameContent';
import { ThemeDecoration } from './themes/ThemeDecoration';

export function Screen({ roomId: resolvedId }: { roomId?: string } = {}) {
  const params = useParams();
  const roomId = resolvedId ?? params.roomId;
  const { state, error, connected, reportMediaEnded } = useLobby(roomId, 'screen');
  const { origin, setOrigin, addresses } = useShareOrigin(state?.room.state === 'LOBBY' && !state.room.closedAt);
  const content = state?.game?.state === 'PAUSED' ? state.game.content : state?.game;
  const preparing = content?.state === 'QUESTION' && !content.preTimer;
  return <ThemeSurface themeId={state?.room.themeId} className="screen-lobby" data-phase={state?.room.closedAt ? 'CLOSED' : state?.room.state}>
    <ThemeDecoration kind="corners" />
    <header className="screen-header">
    <h1>{state?.room.closedAt ? 'Викторина / Quiz' : state?.room.state === 'PAUSED' ? 'Пауза / Paused' : state?.room.state && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.room.state) ? 'Игра / Game' : state?.room.state === 'ANSWER_REVEAL' ? 'Ответ / Answer Reveal' : state?.room.state === 'ROUND_INTRO' ? 'Начало раунда / Round Intro' : (state?.room.state === 'QUESTION' || state?.room.state === 'ANSWERING') ? 'Вопрос / Question' : 'Лобби / Lobby'}</h1>
    {state && <>
      {state.game?.state === 'PAUSED' && !state.room.closedAt && <div className="screen-pause-overlay" role="status"><strong>Пауза / Paused</strong><p>Продолжим по команде ведущего / Waiting for the host</p></div>}
      <h2 className="quiz-title">{state.room.quizTitle}</h2>
      {!connected && <p className="connection-chip" data-connected={false}>Переподключение… / Reconnecting…</p>}
    </>}
    </header>
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p>Загрузка / Loading…</p>}
    {state && <>
      {state.room.closedAt ? <p role="status">Комната закрыта / Room closed</p> : state.room.state !== 'LOBBY'
        ? <section className="game-content">
          {content && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(content.state) && <BoundaryContent game={content as import('./lobby').GameBoundary} />}
          {content?.state === 'ROUND_INTRO' && <RoundIntroContent round={content} />}
          {content && (content.state === 'QUESTION' || content.state === 'ANSWERING' || content.state === 'ANSWER_REVEAL') && (preparing
            ? <div className="question-ready">
              <p className="phase-chip">Раунд {content.roundNumber} / Round {content.roundNumber} · Вопрос / Question {content.questionNumber} / {content.questionCount}</p>
              <h2>Следующий вопрос готов / Next question is ready</h2>
            </div>
            : <QuestionContent question={content} onMediaEnded={state.game?.state === 'PAUSED' ? undefined : (id, revision, duration) => reportMediaEnded(content.questionId ?? '', id, revision, duration)} />)}
          {state.game?.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} />}
        </section> : <>
        <div className="screen-join">
        <ThemeDecoration kind="lobby" />
        <div className="screen-join-panel">
        <p className="eyebrow">Код комнаты / Room code</p>
        <strong className="room-code">{state.room.code}</strong>
        <p>Подключитесь к Wi-Fi и сканируйте QR / Join the Wi-Fi and scan a QR code</p>
        {addresses.length > 1 && <label>Party network<select value={origin ?? ''} onChange={event => setOrigin(event.target.value || null)}>
          <option value="">Choose the party Wi-Fi address</option>
          {addresses.map(item => <option key={item.address} value={reachableOrigin(item.address, window.location.origin)!}>{item.name} — {item.address}</option>)}
        </select></label>}
        {origin ? <PlayerJoinCode origin={origin} code={state.room.code} />
          : <p className="screen-join-warning" role="alert">QR недоступен для телефонов — откройте Screen по LAN-адресу Mac. / Phone QR links need a LAN address. Open Screen using this Mac’s LAN address.</p>}
        </div></div>
      </>}
      {state.room.state === 'LOBBY' && <><p>Игроки / Players: {state.players?.length ?? 0} / 30</p>
      <ul className="screen-roster">{state.players?.map(player => <li key={player.id}>{player.name}</li>)}</ul></>}
    </>}
  </ThemeSurface>;
}
