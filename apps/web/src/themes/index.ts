// Bundled presentation only: no gameplay rules, dynamic loading or external resources.
export type ThemeManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly resources: readonly string[];
  readonly features: readonly string[];
};

export const defaultTheme = {
  manifest: { id: 'default', name: 'Default', version: '1.0.0', author: 'Home Quiz Engine', resources: [], features: [] } satisfies ThemeManifest,
  tokens: {
    font: 'system-ui, sans-serif', text: '#20243d', background: '#eef2fb',
    muted: '#535d76', border: '#d7deed', primary: '#4338b5', onPrimary: '#ffffff',
    danger: '#ad3347', dangerBorder: '#d89ca6', inputBorder: '#8894b0', surface: '#ffffff',
    correctBorder: '#23834a', correctBackground: '#eaf7ee', correctText: '#153c24', tableBorder: '#d7deed',
    accent: '#087c89', glow: '#dcdafa', glowSecondary: '#d5f0f3',
    shadow: '0 18px 60px #283b6a12, 0 3px 10px #283b6a08',
    contentBackground: '#ffffff', contentText: '#20243d', contentMuted: '#59627c',
    selectedBackground: '#eeedff', selectedText: '#33298b',
    wrongBackground: '#fff0f1', wrongText: '#9b293d',
    warningBackground: '#fff4d9', warningText: '#79500e',
  },
} as const;

export type ThemeTokens = { readonly [Key in keyof typeof defaultTheme.tokens]: string };
export type Theme = { readonly manifest: ThemeManifest; readonly tokens?: Partial<ThemeTokens> };
// Both palettes share layout and gameplay; missing optional parts inherit Default.
export const halloweenTheme: Theme = {
  manifest: { id: 'halloween', name: 'Halloween', version: '1.0.0', author: 'Home Quiz Engine', resources: [], features: [] },
  tokens: {
    text: '#fff1de', background: '#1c1426', muted: '#c8b5d3',
    primary: '#ffad62', onPrimary: '#301c24', surface: '#2c203b',
    border: '#594466', inputBorder: '#a48bad', tableBorder: '#594466',
    danger: '#ff9bab', dangerBorder: '#ac6479',
    accent: '#c8b0ef', glow: '#3e2349', glowSecondary: '#352b4c',
    shadow: '0 18px 60px #08050d40, 0 3px 10px #08050d30',
    contentBackground: '#fff4e2', contentText: '#30213b', contentMuted: '#70566f',
    selectedBackground: '#59352c', selectedText: '#fff1de',
    wrongBackground: '#fff0f1', wrongText: '#9b293d',
    warningBackground: '#483423', warningText: '#ffd997',
  },
};
export const themes: readonly Theme[] = [defaultTheme, halloweenTheme];

// Missing configuration parts inherit Default. No optional assets are required to render.
export function resolveTheme(themeId?: string | null) {
  const theme = themes.find(theme => theme.manifest.id === themeId) ?? defaultTheme;
  const tokens = { ...defaultTheme.tokens } as { -readonly [Key in keyof ThemeTokens]: string };
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    tokens[key] = theme.tokens?.[key] || defaultTheme.tokens[key];
  }
  return { manifest: theme.manifest, tokens };
}
