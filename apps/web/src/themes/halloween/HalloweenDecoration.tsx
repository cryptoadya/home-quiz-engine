// Literal module-relative URLs let Vite bundle local assets. Only rendered images
// are requested by the browser; no illustration is a global CSS background.
const artwork = {
  lobby: { src: new URL('./assets/halloween_banner_haunted_house.webp', import.meta.url).href, width: 1672, height: 941 },
  round: { src: new URL('./assets/halloween_pumpkin_cluster.webp', import.meta.url).href, width: 512, height: 512 },
  winner: { src: new URL('./assets/halloween_winner_trophy.webp', import.meta.url).href, width: 640, height: 640 },
  waiting: { src: new URL('./assets/halloween_spooky_candle_scene.webp', import.meta.url).href, width: 640, height: 480 },
  reveal: { src: new URL('./assets/halloween_ghost_mascot.webp', import.meta.url).href, width: 128, height: 128 },
  player: { src: new URL('./assets/halloween_ghost_mascot.webp', import.meta.url).href, width: 128, height: 128 },
  leftWeb: { src: new URL('./assets/halloween_corner_web_top_left.webp', import.meta.url).href, width: 192, height: 192 },
  rightWeb: { src: new URL('./assets/halloween_corner_web_top_right.webp', import.meta.url).href, width: 192, height: 192 },
};

export type DecorationKind = 'lobby' | 'round' | 'winner' | 'waiting' | 'reveal' | 'player' | 'corners';

export function HalloweenDecoration({ kind }: { kind: DecorationKind }) {
  if (kind === 'corners') return <div className="halloween-corners" aria-hidden="true">
    <img {...artwork.leftWeb} className="halloween-art halloween-art--web-left" alt="" aria-hidden="true" decoding="async" />
    <img {...artwork.rightWeb} className="halloween-art halloween-art--web-right" alt="" aria-hidden="true" decoding="async" />
  </div>;
  return <img {...artwork[kind]} className={`halloween-art halloween-art--${kind}`} alt="" aria-hidden="true" decoding="async" />;
}
