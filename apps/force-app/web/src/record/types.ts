// Recording config sent to the backend /record/start (mirrors app/config.py::RecordConfig;
// all fields optional on the wire — the backend supplies defaults).
export interface RecordConfig {
	sample_name?: string;
	rpm?: number;
	feed?: number;
	diam?: number;
	inner_diam?: number;
	sample_rate?: number;
	duration_sec?: number;
	ppr?: number;
	axis?: 'Fx' | 'Fy' | 'Fz';
	frm_from_cut?: boolean;
	drift_comp?: boolean;
	/** Absolute cut-detect force threshold (N) on |Fz|; 0 = adaptive. See Settings > Recording. */
	cut_detect_force?: number;
}

export type Axis = 'Fx' | 'Fy' | 'Fz';

export const AXIS_COLOR: Record<'Fx' | 'Fy' | 'Fz', string> = {
	Fx: '#dc2626',
	Fy: '#16a34a',
	Fz: '#2563eb',
};

// Per-channel colours for the live plot: summed axes keep their canonical hue; each dyno
// sub-channel gets a distinct shade grouped by its parent axis (red-ish / green-ish / blue-ish).
export const CH_COLOR: Record<string, string> = {
	Fx: '#f87171', Fy: '#4ade80', Fz: '#60a5fa',
	Fx1: '#f87171', Fx2: '#fca5a5',
	Fy1: '#4ade80', Fy2: '#86efac',
	Fz1: '#60a5fa', Fz2: '#93c5fd', Fz3: '#38bdf8', Fz4: '#818cf8',
	Tacho: '#a78bfa',
};

// The same channels for the light theme's plot ground (--plot-bg #eef1f6). The hues above are
// tuned for the dark plots; on the light one they fell to ~1.5-2.4:1 (Fy worst), below the ~3:1
// a chart line needs, and their legends/chips were barely legible. Same hue family per axis,
// same "summed = first sub-channel, later subs lighter" ordering.
export const CH_COLOR_LIGHT: Record<string, string> = {
	Fx: '#dc2626', Fy: '#15803d', Fz: '#2563eb',
	Fx1: '#dc2626', Fx2: '#ef4444',
	Fy1: '#15803d', Fy2: '#16a34a',
	Fz1: '#2563eb', Fz2: '#3b82f6', Fz3: '#0284c7', Fz4: '#4f46e5',
	Tacho: '#7c3aed',
};

/** A channel's colour on the given theme — for canvas strokes (which can't read CSS variables)
 *  and for the legends/chips that have to match them. Undefined for unknown channels. */
export function channelColor(ch: string, theme: 'dark' | 'light'): string | undefined {
	return (theme === 'light' ? CH_COLOR_LIGHT[ch] : undefined) ?? CH_COLOR[ch];
}
