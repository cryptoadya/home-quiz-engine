import { useThemeId } from './ThemeSurface';
import type { CurrentQuestion, GameBoundary, RoundIntro } from '../lobby';

export type SceneryKind = 'hall' | 'finale' | 'quiet';
export function screenScenery(content?: CurrentQuestion | GameBoundary | RoundIntro | null): SceneryKind | undefined {
  if (!content) return undefined;
  if (content.state === 'WINNER_SCREEN' || content.state === 'FINAL_RESULTS') return 'finale';
  if (content.state === 'ROUND_INTRO' || content.state === 'ROUND_END' || content.state === 'QUESTION' && !content.preTimer) return 'hall';
  if (content.state === 'ANSWER_REVEAL' || content.state === 'LEADERBOARD' ||
    (content.state === 'ANSWERING' || content.state === 'QUESTION') && !content.media?.some(media => media.kind !== 'audio')) return 'quiet';
  return undefined;
}
const hall = new URL('./halloween/assets/halloween_manor_hall.webp', import.meta.url).href;
const finale = new URL('./halloween/assets/halloween_manor_finale.webp', import.meta.url).href;

// Static atmosphere only. Callers choose a presentation role, never question content.
// A failed optional image leaves the normal theme background intact.
export function ThemeScenery({ kind }: { kind?: SceneryKind }) {
  if (useThemeId() !== 'halloween' || !kind) return null;
  return <div className="theme-scenery" data-kind={kind} aria-hidden="true">
    <img key={kind} src={kind === 'finale' ? finale : hall} alt="" aria-hidden="true" width={1672} height={941}
      decoding="async" onError={event => { event.currentTarget.hidden = true; }} />
  </div>;
}
