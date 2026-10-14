import { DynamicColorIOS, Platform, StyleSheet, type ColorValue } from 'react-native';

/** A token's values: light, dark, and both again for iOS Increase Contrast. */
type Tones = readonly [light: string, dark: string, highContrastLight: string, highContrastDark: string];

/**
 * The palette, one token per row. Dark is a cool near-black with slate surfaces, on which the navy
 * cards still read as raised, and status colors lighten to keep their contrast. Increase Contrast
 * darkens text and separators in light and brightens them in dark.
 */
const tones = {
  background: ['#F6F7F9', '#0B0E14', '#EEF1F5', '#000000'],
  surface: ['#FFFFFF', '#151A23', '#FFFFFF', '#10141B'],
  /** Surfaces above the page, such as sheets: iOS lifts them in dark mode. */
  elevated: ['#FFFFFF', '#1D2330', '#FFFFFF', '#191F2A'],
  ink: ['#0F172A', '#F1F5F9', '#000000', '#FFFFFF'],
  muted: ['#64748B', '#94A3B8', '#334155', '#CBD5E1'],
  faint: ['#94A3B8', '#64748B', '#475569', '#94A3B8'],
  line: ['#E5E9F0', '#262D3A', '#8391A7', '#5B6678'],
  /** Primary buttons and toasts: ink on light, near-white on dark. */
  accent: ['#0F172A', '#F1F5F9', '#000000', '#FFFFFF'],
  /** Text on a solid accent, success, danger or premium fill. */
  onAccent: ['#FFFFFF', '#0B0E14', '#FFFFFF', '#000000'],
  accentSoft: ['#E8ECF2', '#222936', '#DCE2EA', '#2B3342'],
  success: ['#15803D', '#4ADE80', '#166534', '#86EFAC'],
  successSoft: ['#DCFCE7', '#11271B', '#DCFCE7', '#11291C'],
  danger: ['#B91C1C', '#F87171', '#991B1B', '#FCA5A5'],
  dangerSoft: ['#FEE2E2', '#2C1416', '#FEE2E2', '#351617'],
  warning: ['#B45309', '#FBBF24', '#92400E', '#FCD34D'],
  warningSoft: ['#FEF3C7', '#2A2110', '#FEF3C7', '#33280F'],
  premium: ['#6D28D9', '#A78BFA', '#5B21B6', '#C4B5FD'],
  premiumSoft: ['#EDE9FE', '#221B3A', '#EDE9FE', '#2A2147'],
  /** Full-screen brand background: the splash and the welcome screen, dark in both appearances. */
  brand: ['#111827', '#0B0E14', '#0B1120', '#000000'],
  /** The balance card and virtual cards. */
  card: ['#111827', '#1B2436', '#0B1120', '#1B2436'],
  /** Edge of a card, so a dark card stands off a dark page. */
  cardLine: ['#111827', '#2A3449', '#0B1120', '#64748B'],
  cardFrozen: ['#475569', '#333B49', '#334155', '#3A4352'],
  /** Behind a card shown large (card details), a shade darker than the card so its edge still reads. */
  cardBackdrop: ['#0B1120', '#05070B', '#000000', '#000000'],
  /** Text and marks on brand and card surfaces. */
  onCard: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
  onCardMuted: ['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.88)', 'rgba(255,255,255,0.88)'],
  onCardFaint: ['rgba(255,255,255,0.5)', 'rgba(255,255,255,0.5)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0.75)'],
  /** The unfilled part of the logo while it fills. */
  onCardTrack: ['rgba(255,255,255,0.25)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0.4)'],
  /** Dims the page behind a sheet. */
  backdrop: ['rgba(15,23,42,0.45)', 'rgba(0,0,0,0.6)', 'rgba(15,23,42,0.6)', 'rgba(0,0,0,0.75)'],
} as const satisfies Record<string, Tones>;

export type ColorToken = keyof typeof tones;
export type Palette = Record<ColorToken, string>;

const tokens = Object.keys(tones) as ColorToken[];
function table<T>(value: (tones: Tones) => T) {
  return Object.fromEntries(tokens.map((token) => [token, value(tones[token])])) as Record<ColorToken, T>;
}

/**
 * Whether Wallet has a dark appearance on this platform. Only iOS resolves the dark and contrast values
 * (DynamicColorIOS below), so elsewhere the app is light only: its system bars stay light
 * (`userInterfaceStyle` in app.config.ts) and Settings has no Appearance choice.
 */
export const hasDarkAppearance = Platform.OS === 'ios';

/**
 * Theme colors. On iOS each one is a DynamicColorIOS that the native view resolves against the current
 * appearance and contrast, so static imports and module-level styles follow Dark Mode, Settings →
 * Appearance and Increase Contrast without a re-render. Other platforms use the light values.
 */
export const colors: Record<ColorToken, ColorValue> = table(([light, dark, highContrastLight, highContrastDark]) =>
  hasDarkAppearance ? DynamicColorIOS({ light, dark, highContrastLight, highContrastDark }) : light);

/** Plain values of each appearance, for previews that show one whatever the device uses. */
export const palettes: { light: Palette; dark: Palette } = { light: table(([light]) => light), dark: table(([, dark]) => dark) };

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * How far display text may grow with the iPhone's text size (`maxFontSizeMultiplier`). iOS grows titles
 * less than body text at the accessibility sizes (a 34 pt large title peaks near 60 pt, body text near
 * 53 pt), so titles stop at twice their size and large amounts, which must stay on one line, at one and a
 * half; body text, captions and buttons grow all the way. Glyphs drawn inside a fixed shape, such as an
 * avatar's initials or the keypad's digits, stay close to their size, like the iPhone's own.
 */
export const TITLE_MAX_SCALE = 2;
export const AMOUNT_MAX_SCALE = 1.5;
export const GLYPH_MAX_SCALE = 1.3;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

/**
 * Widths on wide screens, such as an unfolded iPhone Duo: a page's content stays at a readable width and is
 * centred, and a card keeps roughly its phone size. On an iPhone held upright neither limit is reached.
 */
export const layout = { contentMaxWidth: 600, cardMaxWidth: 440 } as const;

/**
 * Text styles. Line heights are the font's own: a fixed `lineHeight` grows with the text size into a
 * fractional height that React Native can lay out a hair shorter than it draws, and the last line of a
 * paragraph then disappears at the accessibility sizes.
 */
export const text = StyleSheet.create({
  hero: { fontSize: 34, fontWeight: '700', letterSpacing: -0.8, color: colors.ink },
  title: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5, color: colors.ink },
  heading: { fontSize: 18, fontWeight: '600', color: colors.ink },
  body: { fontSize: 16, color: colors.ink },
  bodyMuted: { fontSize: 16, color: colors.muted },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink },
  caption: { fontSize: 13, color: colors.muted },
  overline: { fontSize: 12, fontWeight: '600', color: colors.muted, letterSpacing: 0.6, textTransform: 'uppercase' },
  amount: { fontSize: 40, fontWeight: '700', letterSpacing: -1.2, color: colors.ink, fontVariant: ['tabular-nums'] },
});
