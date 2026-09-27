import { Countdown } from './Countdown';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useLobby } from './lobby';
import { RoundIntroContent, QuestionContent, BoundaryContent } from './GameContent';

export function Screen() {
  const { roomId } = useParams();
  const { state, error, connected } = useLobby(roomId, 'screen');
  const local = /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);
  return <main className="screen-lobby">
    <h1>{state?.room.closedAt ? 'Викторина / Quiz' : state?.room.state === 'PAUSED' ? 'Пауза / Paused' : state?.room.state && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.room.state) ? 'Игра / Game' : state?.room.state === 'ANSWER_REVEAL' ? 'Ответ / Answer Reveal' : state?.room.state === 'ROUND_INTRO' ? 'Начало раунда / Round Intro' : (state?.room.state === 'QUESTION' || state?.room.state === 'ANSWERING') ? 'Вопрос / Question' : 'Лобби / Lobby'}</h1>
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p>Загрузка / Loading…</p>}
    {state && <>
      <h2>{state.room.quizTitle}</h2>
      <p>{connected ? 'Connected' : 'Reconnecting…'}</p>
      {state.room.closedAt ? <p role="status">Комната закрыта / Room closed</p> : state.room.state !== 'LOBBY'
        ? <section className="game-content">{state.game && ['ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state.game.state) && <BoundaryContent game={state.game as import('./lobby').GameBoundary} />}{state.game?.state === 'ROUND_INTRO' && <RoundIntroContent round={state.game} />}{(state.game?.state === 'QUESTION' || state.game?.state === 'ANSWERING' || state.game?.state === 'ANSWER_REVEAL') && <QuestionContent question={state.game} />}{state.game?.state === 'ANSWERING' && state.game.timer && <Countdown timer={state.game.timer} />}</section> : <>
        <p>Код комнаты / Room code</p>
        <strong className="room-code">{state.room.code}</strong>
        <p>Подключитесь к Wi-Fi и сканируйте QR / Join the Wi-Fi and scan a QR code</p>
        {local && <p role="alert">Откройте экран по LAN-адресу / Open Screen using this computer’s LAN address; localhost QR links will not work on phones.</p>}
        <div className="join-codes">{(['ru', 'en'] as const).map(language => {
          const url = new URL(`/play/${encodeURIComponent(state.room.code)}`, window.location.origin);
          url.searchParams.set('lang', language);
          return <a key={language} href={url.href} aria-label={language.toUpperCase()}>
            <QRCodeSVG value={url.href} size={240} marginSize={4} level="M" />
            <span>{language.toUpperCase()}</span>
          </a>;
        })}</div>
      </>}
      {state.room.state === 'LOBBY' && <><p>Игроки / Players: {state.players?.length ?? 0} / 30</p>
      <ul className="screen-roster">{state.players?.map(player => <li key={player.id}>{player.name}</li>)}</ul></>}
    </>}
  </main>;
}
