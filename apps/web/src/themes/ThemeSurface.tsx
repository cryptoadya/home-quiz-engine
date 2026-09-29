import { createContext, useContext, type CSSProperties, type HTMLAttributes } from 'react';
import { resolveTheme } from './index';

type Props = HTMLAttributes<HTMLElement> & { as?: 'main' | 'div'; themeId?: string | null };
const ThemeContext = createContext('default');
export const useThemeId = () => useContext(ThemeContext);

// A scoped root lets the same components render editable or frozen quiz presentation.
export function ThemeSurface({ themeId, style, as: Element = 'main', ...props }: Props) {
  const theme = resolveTheme(themeId);
  const variables = Object.fromEntries(Object.entries(theme.tokens).map(([key, value]) => [`--theme-${key}`, value]));
  return <ThemeContext.Provider value={theme.manifest.id}><Element {...props} data-theme={theme.manifest.id} style={{ ...variables, ...style } as CSSProperties} /></ThemeContext.Provider>;
}
