import type { CSSProperties, HTMLAttributes } from 'react';
import { resolveTheme } from './index';

type Props = HTMLAttributes<HTMLElement> & { themeId?: string | null };

// A scoped root lets the same components render editable or frozen quiz presentation.
export function ThemeSurface({ themeId, style, ...props }: Props) {
  const theme = resolveTheme(themeId);
  const variables = Object.fromEntries(Object.entries(theme.tokens).map(([key, value]) => [`--theme-${key}`, value]));
  return <main {...props} data-theme={theme.manifest.id} style={{ ...variables, ...style } as CSSProperties} />;
}
