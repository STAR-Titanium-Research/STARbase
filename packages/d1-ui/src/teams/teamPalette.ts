// The team colours: the ten keys the teams table allows (teams_color_check; core/extensions/d1-teams PALETTE) and, for each, the tile's
// background and text in a light and in a dark scheme. Every pair is at least 4.5:1 (WCAG AA for text), pinned by teamPalette.test.ts.
// Light: a deep hue with white text. Dark: a darker hue with a pale tint of it, so the tile does not glare on a dark page.

export const TEAM_COLORS = ['teal', 'blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'slate'] as const;
export type TeamColor = (typeof TEAM_COLORS)[number];

export interface TeamPaint {
	bg: string;
	fg: string;
}

export const TEAM_PALETTE: Record<TeamColor, { light: TeamPaint; dark: TeamPaint }> = {
	teal: { light: { bg: '#0f766e', fg: '#ffffff' }, dark: { bg: '#115e59', fg: '#ccfbf1' } },
	blue: { light: { bg: '#1d4ed8', fg: '#ffffff' }, dark: { bg: '#1e40af', fg: '#dbeafe' } },
	indigo: { light: { bg: '#4338ca', fg: '#ffffff' }, dark: { bg: '#3730a3', fg: '#e0e7ff' } },
	violet: { light: { bg: '#6d28d9', fg: '#ffffff' }, dark: { bg: '#5b21b6', fg: '#ede9fe' } },
	pink: { light: { bg: '#be185d', fg: '#ffffff' }, dark: { bg: '#9d174d', fg: '#fce7f3' } },
	red: { light: { bg: '#b91c1c', fg: '#ffffff' }, dark: { bg: '#991b1b', fg: '#fee2e2' } },
	orange: { light: { bg: '#c2410c', fg: '#ffffff' }, dark: { bg: '#9a3412', fg: '#ffedd5' } },
	amber: { light: { bg: '#b45309', fg: '#ffffff' }, dark: { bg: '#92400e', fg: '#fef3c7' } },
	green: { light: { bg: '#15803d', fg: '#ffffff' }, dark: { bg: '#166534', fg: '#dcfce7' } },
	slate: { light: { bg: '#475569', fg: '#ffffff' }, dark: { bg: '#334155', fg: '#e2e8f0' } },
};

export const DEFAULT_TEAM_COLOR: TeamColor = 'teal';

export const isTeamColor = (color: unknown): color is TeamColor => typeof color === 'string' && (TEAM_COLORS as readonly string[]).includes(color);

/** The palette entry for a key; an unknown or missing key falls back to teal, the table's default. */
export const paletteFor = (color: string | null | undefined): { light: TeamPaint; dark: TeamPaint } =>
	TEAM_PALETTE[isTeamColor(color) ? color : DEFAULT_TEAM_COLOR];

/** The tile's colours as a CSS value pair for one property, e.g. light-dark(#0f766e, #115e59). Needs color-scheme (the kit's frame sets it). */
export function lightDark(color: string | null | undefined, part: keyof TeamPaint): string {
	const p = paletteFor(color);
	return `light-dark(${p.light[part]}, ${p.dark[part]})`;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** The letters in a tile with no logo: the first letters of the first two words, upper case ("Sintering Lab" is "SL", "Atlas" is "A"). */
export function teamInitials(name: string): string {
	const words = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
	if (!words.length) return '?';
	return words.map((w) => Array.from(w)[0]).join('').toUpperCase();
}
