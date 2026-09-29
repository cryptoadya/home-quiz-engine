// Literal module-relative URLs let Vite bundle local assets. Only rendered images
// are requested by the browser; no illustration is a global CSS background.
const artwork = {
  lobby: { src: new URL('./assets/halloween_banner_haunted_house.png', import.meta.url).href, width: 1672, height: 941 },
  round: { src: new URL('./assets/halloween_pumpkin_cluster.png', import.meta.url).href, width: 1254, height: 1254 },
  winner: { src: new URL('./assets/halloween_winner_trophy.png', import.meta.url).href, width: 1254, height: 1254 },
  waiting: { src: new URL('./assets/halloween_spooky_candle_scene.png', import.meta.url).href, width: 1448, height: 1086 },
  player: { src: new URL('./assets/halloween_ghost_mascot.png', import.meta.url).href, width: 1254, height: 1254 },
  leftWeb: { src: new URL('./assets/halloween_corner_web_top_left.png', import.meta.url).href, width: 1254, height: 1254 },
  rightWeb: { src: new URL('./assets/halloween_corner_web_top_right.png', import.meta.url).href, width: 1254, height: 1254 },
};

export type DecorationKind = 'lobby' | 'round' | 'winner' | 'waiting' | 'player' | 'corners';

export function HalloweenDecoration({ kind }: { kind: DecorationKind }) {
  if (kind === 'corners') return <div className="halloween-corners" aria-hidden="true">
    <img {...artwork.leftWeb} className="halloween-art halloween-art--web-left" alt="" aria-hidden="true" decoding="async" />
    <img {...artwork.rightWeb} className="halloween-art halloween-art--web-right" alt="" aria-hidden="true" decoding="async" />
  </div>;
  return <img {...artwork[kind]} className={`halloween-art halloween-art--${kind}`} alt="" aria-hidden="true" decoding="async" />;
}
