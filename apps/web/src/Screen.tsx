import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useLobby } from './lobby';

export function Screen() {
  const { roomId } = useParams();
  const { state, error, connected } = useLobby(roomId, 'screen');
  const local = /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);
  return <main className="screen-lobby">
    <h1>{state?.room.state === 'ROUND_INTRO' ? 'Начало раунда / Round Intro' : 'Лобби / Lobby'}</h1>
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p>Загрузка / Loading…</p>}
    {state && <>
      <h2>{state.room.quizTitle}</h2>
      <p>{connected ? 'Connected' : 'Reconnecting…'}</p>
      {state.room.closedAt ? <p role="status">Комната закрыта / Room closed</p> : state.room.state === 'ROUND_INTRO'
        ? <p role="status">Игра начинается… / Game starting…</p> : <>
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
      <p>Игроки / Players: {state.players?.length ?? 0} / 30</p>
      <ul className="screen-roster">{state.players?.map(player => <li key={player.id}>{player.name}</li>)}</ul>
    </>}
  </main>;
}
