import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { lobbyTransport } from './lobby';
import { reachableOrigin, useShareOrigin } from './share-origin';

type Command = { action: 'picture' | 'sound' | 'stop'; revision: number };
type Report = { revision: number; status: 'picture' | 'playing' | 'ended' | 'blocked' | 'error' | 'stopped' };
const messages: Record<Report['status'], string> = {
  picture: 'Картинка показана. Проверьте, что рамка видна целиком, а круг выглядит круглым.',
  playing: 'Screen проигрывает звук. Проверьте, что он слышен из нужных колонок.',
  ended: 'Звук завершён. Если его не было слышно, проверьте громкость и выбранные колонки.',
  blocked: 'Браузер блокирует звук. Нажмите «Разрешить звук» непосредственно на Screen.',
  error: 'Не удалось проиграть звук на Screen. Проверьте браузер и повторите действие.',
  stopped: 'Проверка остановлена.',
};

function useScreenCheck(quizId: string | undefined, role: 'admin' | 'screen', onCommand?: (command: Command) => void) {
  const socket = useRef<Socket | null>(null);
  const handler = useRef(onCommand); handler.current = onCommand;
  const [connected, setConnected] = useState(false);
  const [screens, setScreens] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!quizId) return;
    const live = lobbyTransport.connect(); socket.current = live;
    let active = true;
    const lost = () => {
      setConnected(false); setScreens(0); setReport(null);
      handler.current?.({ action: 'stop', revision: -1 });
    };
    live.on('connect', () => {
      live.emit('screen-check:subscribe', { quizId, role }, (result: { accepted: boolean; screens: number }) => {
        if (!active) return;
        setConnected(result.accepted); setScreens(result.screens);
        setError(result.accepted ? '' : 'Викторина недоступна. Вернитесь в Admin и откройте проверку снова.');
      });
    });
    live.on('disconnect', lost);
    live.on('connect_error', () => { lost(); setError('Нет связи с сервером. Проверьте Wi-Fi и запуск приложения.'); });
    live.on('screen-check:presence', (input: { screens: number }) => { setScreens(input.screens); setReport(null); });
    live.on('screen-check:report', (input: Report) => setReport(input));
    live.on('screen-check:command', (input: Command) => handler.current?.(input));
    live.connect();
    return () => { active = false; live.removeAllListeners(); live.disconnect(); socket.current = null; };
  }, [quizId, role]);
  function command(action: Command['action']) {
    if (!connected || !screens) return;
    setError(''); setReport(null);
    socket.current?.emit('screen-check:command', { action }, (result: { accepted: boolean }) => {
      if (!result.accepted) setError('Команда не выполнена. Проверьте подключение Screen и повторите действие.');
    });
  }
  const sendReport = (input: Report) => socket.current?.emit('screen-check:report', input);
  return { connected, screens, report, error, command, sendReport };
}

export function ScreenCheckPanel({ quizId }: { quizId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="equipment-check">
    <button className="subtle" onClick={() => setOpen(value => !value)} aria-expanded={open}>Проверить экран и звук</button>
    {open && <AdminScreenCheck key={quizId} quizId={quizId} />}
  </div>;
}

function AdminScreenCheck({ quizId }: { quizId: string }) {
  const check = useScreenCheck(quizId, 'admin');
  const { origin, setOrigin, addresses } = useShareOrigin();
  return <section aria-label="Проверка оборудования">
    <p>Откройте эту ссылку в браузере, который показывает картинку на телевизоре. Игроки и игровая комната не нужны.</p>
    {addresses.length > 1 && <label>Сеть вечеринки<select value={origin ?? ''} onChange={event => setOrigin(event.target.value || null)}>
      <option value="">Выберите адрес Wi-Fi</option>
      {addresses.map(item => <option key={item.address} value={reachableOrigin(item.address, window.location.origin)!}>{item.name} — {item.address}</option>)}
    </select></label>}
    <a href={`${origin ?? window.location.origin}/screen-check/${encodeURIComponent(quizId)}`} target="_blank" rel="noreferrer">Открыть проверку на Screen</a>
    {!origin && <p>Для другого устройства откройте ссылку по LAN-адресу Mac вместо localhost.</p>}
    <p role="status">{!check.connected ? 'Подключение к серверу…' : check.screens ? `Screen подключён: ${check.screens}` : 'Ожидаем подключения Screen.'}</p>
    <div className="authoring-actions">
      <button disabled={!check.connected || !check.screens} onClick={() => check.command('picture')}>Показать картинку</button>
      <button disabled={!check.connected || !check.screens} onClick={() => check.command('sound')}>Проиграть звук</button>
      <button className="subtle" disabled={!check.connected || !check.screens} onClick={() => check.command('stop')}>Остановить проверку</button>
    </div>
    {check.report && <p role="status">{messages[check.report.status]}</p>}
    {check.error && <p role="alert">{check.error}</p>}
  </section>;
}

export function ScreenCheck() {
  const { quizId } = useParams();
  const audio = useRef<AudioContext | null>(null);
  const current = useRef<Command>({ action: 'stop', revision: -1 });
  const [blocked, setBlocked] = useState(false);
  const [status, setStatus] = useState('Откройте проверку в Admin и нажмите «Показать картинку» или «Проиграть звук».');
  const sendReportRef = useRef<(input: Report) => void>(() => {});
  function stopAudio() { const previous = audio.current; audio.current = null; if (previous) void previous.close().catch(() => {}); }
  function report(command: Command, state: Report['status']) {
    if (current.current !== command) return;
    setStatus(messages[state]); sendReportRef.current({ revision: command.revision, status: state });
  }
  function play(command: Command) {
    stopAudio(); setBlocked(false);
    try {
      const context = new AudioContext(); audio.current = context;
      // A remote Admin click does not grant autoplay permission on this browser.
      if (context.state !== 'running') { setBlocked(true); report(command, 'blocked'); }
      void context.resume().then(() => {
        if (audio.current !== context || current.current !== command) return;
        if (context.state !== 'running') { setBlocked(true); report(command, 'blocked'); return; }
        setBlocked(false);
        const tone = context.createOscillator(), gain = context.createGain();
        tone.frequency.value = 440;
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.gain.linearRampToValueAtTime(0.08, context.currentTime + 0.05);
        gain.gain.setValueAtTime(0.08, context.currentTime + 2.9);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 3);
        tone.connect(gain); gain.connect(context.destination);
        tone.onended = () => {
          if (audio.current !== context || current.current !== command) return;
          report(command, 'ended'); stopAudio();
        };
        tone.start(); tone.stop(context.currentTime + 3); report(command, 'playing');
      }).catch(() => { if (current.current === command && audio.current === context) { setBlocked(true); report(command, 'blocked'); } });
    } catch { setBlocked(false); report(command, 'error'); stopAudio(); }
  }
  const check = useScreenCheck(quizId, 'screen', command => {
    current.current = command; stopAudio(); setBlocked(false);
    if (command.action === 'sound') play(command);
    else report(command, command.action === 'picture' ? 'picture' : 'stopped');
  });
  sendReportRef.current = check.sendReport;
  useEffect(() => () => { current.current = { action: 'stop', revision: -1 }; stopAudio(); }, []);
  return <main className="screen-equipment-check">
    <div className="equipment-picture" role="img" aria-label="Тестовая картинка: рамка, круг и четыре цвета">
      <div className="equipment-colors"><span /><span /><span /><span /></div>
      <div className="equipment-circle">Screen</div>
      <p>Все края рамки должны быть видны. Круг должен оставаться круглым.</p>
    </div>
    <h1>Проверка экрана и звука</h1>
    <p role="status">{check.connected ? status : 'Нет связи с сервером. Проверка остановлена.'}</p>
    {blocked && <button onClick={() => play(current.current)}>Разрешить звук</button>}
    {check.error && <p role="alert">{check.error}</p>}
  </main>;
}
