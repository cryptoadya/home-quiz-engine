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
    font: 'system-ui, sans-serif', text: '#1c2430', background: '#f5f7fa',
    muted: '#5b6470', border: '#d4dbe3', primary: '#254f9a', onPrimary: '#ffffff',
    danger: '#a12424', dangerBorder: '#c8a4a4', inputBorder: '#9da9b7', surface: '#ffffff',
    correctBorder: '#23834a', correctBackground: '#eaf7ee', correctText: '#153c24', tableBorder: '#cccccc',
  },
} as const;

export type ThemeTokens = { readonly [Key in keyof typeof defaultTheme.tokens]: string };
export type Theme = { readonly manifest: ThemeManifest; readonly tokens?: Partial<ThemeTokens> };
export const themes: readonly Theme[] = [defaultTheme];

// Missing configuration parts inherit Default. No optional assets are required to render.
export function resolveTheme(themeId?: string | null) {
  const theme = themes.find(theme => theme.manifest.id === themeId) ?? defaultTheme;
  const tokens = { ...defaultTheme.tokens } as { -readonly [Key in keyof ThemeTokens]: string };
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    tokens[key] = theme.tokens?.[key] || defaultTheme.tokens[key];
  }
  return { manifest: theme.manifest, tokens };
}
