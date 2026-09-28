import { ThemeSurface } from './themes/ThemeSurface';
import { PlayerRevealContent } from './PlayerReveal';
import { PlayerAnswer } from './PlayerAnswer';
import { useLobby, type Room, type PlayerQuestion, type PlayerReveal } from './lobby';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

type Identity = { player: { id: string; name: string; language: 'ru' | 'en'; joinedAt: string }; room: Room; active: boolean; game?: PlayerQuestion | PlayerReveal | null };
const storageKey = (code: string) => `quiz-player:${code}`;

export function Play() {
  const { code = '' } = useParams();
  // A new route must not retain the previous room's identity or pending form.
  return <PlayerRoom key={code.trim().toUpperCase()} code={code.trim().toUpperCase()} />;
}

function PlayerRoom({ code }: { code: string }) {
  const navigate = useNavigate();
  const [enteredCode, setEnteredCode] = useState(code);
  const [room, setRoom] = useState<Room | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [name, setName] = useState('');
  const [searchParams] = useSearchParams();
  const [language, setLanguage] = useState<'ru' | 'en'>(() => searchParams.get('lang') === 'en' ? 'en' : 'ru');
  const { state: live, error: subscriptionError, removed } = useLobby(identity?.room.id, 'player', token);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(Boolean(code));
  const [retry, setRetry] = useState(0);
  const identityRevision = useRef(0);

  useEffect(() => {
    if (!code) return;
    let active = true;
    const revision = ++identityRevision.current;
    setBusy(true);
    setError('');
    async function load() {
      const raw = window.localStorage.getItem(storageKey(code));
      let saved: { roomId: string; token: string } | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.roomId === 'string' && typeof parsed?.token === 'string') saved = parsed;
        } catch { /* Corrupt local data cannot restore an identity. */ }
        if (!saved) window.localStorage.removeItem(storageKey(code));
      }
      if (saved) {
        const response = await fetch(`/api/rooms/${encodeURIComponent(saved.roomId)}/reconnect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: saved.token }),
        });
        const body = await response.json();
        if (!active || revision !== identityRevision.current) return;
        if (response.ok) { if (active) { setToken(saved.token); setIdentity(body); } return; }
        if (response.status !== 401 && response.status !== 404) throw new Error(body.error || 'Could not reconnect. Please retry.');
        window.localStorage.removeItem(storageKey(code));
      }
      const response = await fetch(`/api/rooms/code/${encodeURIComponent(code)}`);
      const body = await response.json();
      if (!active || revision !== identityRevision.current) return;
      if (!response.ok) throw new Error(body.error || 'Could not find room.');
      if (body.state !== 'LOBBY' || body.closedAt) throw new Error('Game has already started or room is no longer accepting players.');
      if (active) setRoom(body);
    }
    void load().catch((cause: Error) => { if (active && revision === identityRevision.current) setError(cause.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [code, retry]);

  // Socket metadata invalidates the authenticated HTTP projection, including on reconnect.
  // Player subscriptions authenticate with the same stored token as HTTP reconnect.
  useEffect(() => {
    if (live) identityRevision.current++;
    const revision = identityRevision.current;
    if (live) {
      // A boundary or changed phase invalidates the previous question projection.
      // Keep same-phase state so an acknowledged Submit remains locked while refreshing.
      setIdentity(previous => previous?.game && (live.room.closedAt || previous.game.state !== live.room.state)
        ? { ...previous, game: null } : previous);
    }
    if (!live || live.room.closedAt || !token) return;
    let active = true;
    void fetch(`/api/rooms/${encodeURIComponent(live.room.id)}/reconnect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }).then(async response => {
      const body = await response.json();
      if (!active || revision !== identityRevision.current) return;
      if (!response.ok) throw new Error(body.error || 'Could not load question.');
      setIdentity(body); setError('');
    }).catch((cause: Error) => { if (active && revision === identityRevision.current) setError(cause.message); });
    return () => { active = false; };
  }, [live, token]);

  useEffect(() => {
    if (removed) { identityRevision.current++; setIdentity(previous => previous ? { ...previous, active: false, game: null } : previous); }
  }, [removed]);

  async function updateIdentity(changes: { name?: string; language?: 'ru' | 'en' }) {
    if (!identity || !token) return;
    const revision = ++identityRevision.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/rooms/${identity.room.id}/player`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...changes }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not update player.');
      // The command response is fresh; a subsequent socket refresh restores gameplay.
      if (revision === identityRevision.current && !removed) setIdentity(body);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function join() {
    if (!room || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/code/${encodeURIComponent(room.code)}/players`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, language }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not join room.');
      setToken(body.token);
      setIdentity(body);
      try {
        window.localStorage.setItem(storageKey(room.code), JSON.stringify({ roomId: body.room.id, token: body.token }));
      } catch { setError('Joined, but this browser could not save your identity. Keep this page open.'); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const ru = identity?.player.language === 'ru';
  const currentRoom = live?.room ?? identity?.room;
  const isActive = !removed && identity?.active && currentRoom?.closedAt === null;
  return <ThemeSurface themeId={(currentRoom ?? room)?.themeId} className="player" data-phase={currentRoom?.closedAt ? 'CLOSED' : currentRoom?.state} data-excluded={identity?.game?.excluded || undefined}>
    <h1>Player</h1>
    {error && <p role="alert">{error}</p>}
    {subscriptionError && <p role="alert">{subscriptionError} {ru ? 'Обновите страницу для повторного подключения.' : 'Reload to reconnect.'}</p>}
    {identity ? <>
      <header className="player-header"><h2>{currentRoom?.quizTitle}</h2>
      <div className="player-meta"><p className="phase-chip">{currentRoom?.code}</p>
      <p>{identity.player.name}</p></div></header>
      {removed && <p className="state-notice excluded" role="status">{ru ? 'Ведущий удалил вас из игры.' : 'The host removed you from the game.'}</p>}
      {isActive && <div className="fields player-settings">
        <label>{ru ? 'Язык' : 'Language'}<select aria-label="Player language" value={identity.player.language} disabled={busy} onChange={event => void updateIdentity({ language: event.target.value as 'ru' | 'en' })}>
          <option value="ru">RU</option><option value="en">EN</option>
        </select></label>
        {currentRoom?.state === 'LOBBY' && <form onSubmit={event => { event.preventDefault(); void updateIdentity({ name: name || identity.player.name }); }}>
          <label>{ru ? 'Новое имя' : 'New name'}<input aria-label="New player name" value={name || identity.player.name} onChange={event => setName(event.target.value)} maxLength={20} /></label>
          <button disabled={busy} type="submit">{ru ? 'Изменить имя' : 'Rename'}</button>
        </form>}
      </div>}
      {!removed && (isActive && (currentRoom?.state === 'ANSWERING' || currentRoom?.state === 'ANSWER_REVEAL') ? <section>
        {identity.game?.state === 'ANSWER_REVEAL' ? <PlayerRevealContent question={identity.game} language={identity.player.language} /> : identity.game?.excluded && currentRoom?.state === 'ANSWERING' ? <p className="state-notice excluded" role="status">{ru ? 'Этот вопрос продолжен без вас' : 'This question continued without you'}</p> : identity.game && token && currentRoom?.state === 'ANSWERING' ? <PlayerAnswer key={identity.game.questionId} question={identity.game}
          token={token} roomId={identity.room.id} language={identity.player.language} /> : <p role="status">{ru ? 'Загрузка вопроса…' : 'Loading question…'}</p>}
        {error && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
      </section> : <p className="state-notice player-waiting" role="status">{isActive
        ? (currentRoom?.state === 'PAUSED' ? (ru ? 'Пауза' : 'Paused') : currentRoom?.state === 'ROUND_INTRO'
          ? (ru ? 'Раунд начинается…' : 'Round is starting…')
          : currentRoom?.state === 'QUESTION' ? (ru ? 'Приготовьтесь к вопросу' : 'Get ready for the question')
           : currentRoom?.state === 'ROUND_END' ? (ru ? 'Раунд завершён' : 'Round complete')
          : currentRoom?.state === 'LEADERBOARD' ? (ru ? 'Смотрите на экран' : 'Look at the screen')
          : currentRoom?.state === 'FINAL_RESULTS' ? (ru ? 'Финальные результаты' : 'Final results')
          : currentRoom?.state === 'WINNER_SCREEN' ? (ru ? 'Игра завершена' : 'Game finished')
          : (ru ? 'Ожидайте ведущего…' : 'Waiting for the host…'))
        : (ru ? 'Комната закрыта' : 'Room closed')}</p>)}
    </> : <>
      <form className="fields" onSubmit={(event) => {
        event.preventDefault();
        const next = enteredCode.trim().toUpperCase();
        if (next === code) setRetry(value => value + 1);
        else navigate(`/play/${encodeURIComponent(next)}`);
      }}>
        <label>Room code<input value={enteredCode} onChange={event => setEnteredCode(event.target.value)} required
          autoCapitalize="characters" autoCorrect="off" spellCheck={false} readOnly={Boolean(room)} /></label>
        {!room && <button disabled={busy} type="submit">{code && error ? 'Retry' : 'Find room'}</button>}
      </form>
      {busy && !room && <p role="status">Loading room…</p>}
      {room && <>
        <h2>{room.quizTitle}</h2>
        <form className="fields" onSubmit={event => { event.preventDefault(); void join(); }}>
          <label>Name<input value={name} onChange={event => setName(event.target.value)} required autoComplete="nickname" /></label>
          <p>Up to 20 characters: letters, spaces, hyphens and apostrophes.</p>
          <label>Language<select value={language} onChange={event => setLanguage(event.target.value as 'ru' | 'en')}>
            <option value="ru">RU</option><option value="en">EN</option>
          </select></label>
          <button type="submit" disabled={busy}>Join</button>
        </form>
      </>}
    </>}
  </ThemeSurface>;
}
