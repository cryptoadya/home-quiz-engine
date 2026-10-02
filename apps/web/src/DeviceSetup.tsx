import { useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Room } from './lobby';
import { reachableOrigin, useShareOrigin } from './share-origin';

export function PlayerJoinCode({ origin, code }: { origin: string; code: string }) {
  const url = new URL(`/play/${encodeURIComponent(code)}`, origin).href;
  return <div className="join-codes"><a href={url} aria-label="Players / Игроки">
    <QRCodeSVG value={url} size={240} marginSize={4} level="M" />
    <span>Players / Игроки</span>
  </a></div>;
}

function DeviceLink({ title, label, url }: { title: string; label: string; url: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await window.navigator.clipboard.writeText(url);
      setFeedback('Copied');
    } catch {
      input.current?.focus(); input.current?.select();
      setFeedback('Select the link and copy it, or open it directly.');
    }
  }
  return <section className="device-link"><h3>{title}</h3>
    <a href={url} aria-label={`Open ${label}`}><QRCodeSVG value={url} size={180} marginSize={4} level="M" /><span>Open {label}</span></a>
    <textarea rows={5} ref={input} aria-label={`${label} link`} value={url} readOnly onFocus={event => event.target.select()} />
    <button onClick={() => void copy()} aria-label={`Copy ${label} link`}>Copy Link</button>
    {feedback && <p role="status">{feedback}</p>}
  </section>;
}

export function DeviceSetup({ room }: { room: Room }) {
  const { origin, setOrigin, addresses, loading } = useShareOrigin();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  function choose(value: string) {
    const next = reachableOrigin(value, window.location.origin);
    setError(next ? '' : 'Use this Mac’s Wi-Fi address, for example 192.168.1.50. Localhost cannot be shared with other devices.');
    if (next) setOrigin(next);
  }
  const query = new URLSearchParams({ code: room.code, ...(room.shareKey ? { session: room.shareKey } : {}) });
  return <section className="device-setup" aria-label="Device setup / Подключение устройств">
    <h2>Подключение устройств / Device setup</h2>
    <p>Код комнаты / Room code: <strong>{room.code}</strong></p>
    <p>Connect all devices to the same Wi-Fi as this Mac.</p>
    {loading && <p role="status">Finding this Mac’s network address…</p>}
    {!loading && !origin && <p>Choose this Mac’s address on the party Wi-Fi to share links.</p>}
    {addresses.length > 1 && <label>Party network<select value={selected} onChange={event => {
      setSelected(event.target.value);
      if (event.target.value) choose(event.target.value); else setOrigin(null);
    }}><option value="">Choose the party Wi-Fi address</option>{addresses.map(item => <option key={item.address} value={item.address}>{item.name} — {item.address}</option>)}</select></label>}
    <details open={!loading && !origin}><summary>Network address</summary>
      <p>If needed, use the Wi-Fi address in Mac System Settings → Wi-Fi → Details → TCP/IP, or open this page using that address. If a phone cannot open a link, choose another address here.</p>
      <form className="fields" onSubmit={event => { event.preventDefault(); choose(manual); }}>
        <label>Network address<input value={manual} onChange={event => setManual(event.target.value)} placeholder="192.168.1.50" required /></label>
        <button>Use address</button>
      </form>
    </details>
    {error && <p role="alert">{error}</p>}
    {origin && <div className="device-links">
      <DeviceLink key={`host:${origin}`} title="Host / Ведущий" label="Host" url={`${origin}/host?${query}`} />
      <DeviceLink key={`screen:${origin}`} title="Screen / Экран" label="Screen" url={`${origin}/screen?${query}`} />
      <section className="device-link"><h3>Players / Игроки</h3><PlayerJoinCode origin={origin} code={room.code} />
        <p>Guests scan this QR, then enter their name and choose RU / EN.</p>
        <p>Or open <a href={`${origin}/play`}>{origin}/play</a> and enter <strong>{room.code}</strong>.</p>
      </section>
    </div>}
    {origin && <p>TV with a keyboard: open <a href={`${origin}/screen`}>{origin}/screen</a> and enter <strong>{room.code}</strong>.</p>}
  </section>;
}
