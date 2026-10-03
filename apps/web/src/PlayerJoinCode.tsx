import { QRCodeSVG } from 'qrcode.react';

export function PlayerJoinCode({ origin, code }: { origin: string; code: string }) {
  const url = new URL(`/play/${encodeURIComponent(code)}`, origin).href;
  return <div className="join-codes"><a href={url} aria-label="Players / Игроки">
    <QRCodeSVG value={url} size={240} marginSize={4} level="M" />
    <span>Players / Игроки</span>
  </a></div>;
}
