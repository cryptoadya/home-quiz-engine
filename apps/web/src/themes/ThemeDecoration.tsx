import { PartyDecoration } from './PartyDecoration';
import { useThemeId } from './ThemeSurface';
import { HalloweenDecoration, type DecorationKind } from './halloween/HalloweenDecoration';

// Shared surfaces ask for a presentation role, without selecting theme artwork.
export function ThemeDecoration({ kind }: { kind: DecorationKind }) {
  if (useThemeId() === 'halloween') return <HalloweenDecoration kind={kind} />;
  return kind === 'round' || kind === 'winner' ? <PartyDecoration /> : null;
}
