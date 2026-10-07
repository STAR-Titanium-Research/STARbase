// The Record page's cut SETUP (machine settings, sample / machine / operator picks, operation
// type, coolant, depths), remembered across launches (R1). Until now all of it reset to blank on
// every start, so each session began by re-picking the same sample, machine and operator.
//
// Only what carries from one cut to the next lives here. Per-cut fields (notes, pass code,
// operation sequence, chips ref, chips collected, new edge) are deliberately not part of the shape
// at all, so a stored entry cannot bring them back. Insert / edge / tool turn over every cut and
// are left out too. `duration_sec` has no input any more and is not stored.
//
// Parsed field by field like plotPrefs.ts: a value from an older build, a hand edit or a
// half-written entry falls back to that field's default instead of reaching the form as NaN, and
// one bad field never costs the others.

export interface SetupPrefs {
	cfg: { rpm: number; feed: number; diam: number; inner_diam: number; sample_rate: number; ppr: number };
	link: {
		sampleId: string; sampleLabel: string; operatorId: string; operatorLabel: string;
		equipmentId: string; equipmentLabel: string;
	};
	meta: { sample_name: string; sample_code: string; op_type: string; coolant: string };
	machining: { axial_doc: string; radial_doc: string; cutting_length: string; coolant_pressure: string };
}

export const SETUP_PREFS_KEY = 'force-app.record.setup.v1';

export function defaultSetupPrefs(): SetupPrefs {
	return {
		cfg: { rpm: 1200, feed: 0.05, diam: 80, inner_diam: 0, sample_rate: 25000, ppr: 1 },
		link: { sampleId: '', sampleLabel: '', operatorId: '', operatorLabel: '', equipmentId: '', equipmentLabel: '' },
		meta: { sample_name: '', sample_code: '', op_type: '', coolant: '' },
		machining: { axial_doc: '', radial_doc: '', cutting_length: '', coolant_pressure: '' },
	};
}

/** A finite number at or above `min`, else the default. (A cleared number input holds '' or NaN.) */
function num(v: unknown, min: number, d: number): number {
	return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d;
}
/** Every key of `defaults` read as a string from `src`; anything else falls back to the default. */
function strings<T extends Record<string, string>>(src: unknown, defaults: T): T {
	const o = src && typeof src === 'object' && !Array.isArray(src) ? (src as Record<string, unknown>) : {};
	const out: Record<string, string> = {};
	for (const k of Object.keys(defaults)) out[k] = typeof o[k] === 'string' ? (o[k] as string) : defaults[k];
	return out as T;
}

/** Stored JSON (or null) -> a complete, valid SetupPrefs. Never throws. */
export function parseSetupPrefs(raw: string | null): SetupPrefs {
	const d = defaultSetupPrefs();
	let o: any;
	try { o = raw ? JSON.parse(raw) : null; } catch { return d; }
	if (!o || typeof o !== 'object' || Array.isArray(o)) return d;
	const c = o.cfg && typeof o.cfg === 'object' ? o.cfg : {};
	return {
		cfg: {
			rpm: num(c.rpm, 0, d.cfg.rpm),
			feed: num(c.feed, 0, d.cfg.feed),
			diam: num(c.diam, 0, d.cfg.diam),
			inner_diam: num(c.inner_diam, 0, d.cfg.inner_diam),
			sample_rate: num(c.sample_rate, 1, d.cfg.sample_rate),
			ppr: num(c.ppr, 1, d.cfg.ppr),
		},
		link: strings(o.link, d.link),
		meta: strings(o.meta, d.meta),
		machining: strings(o.machining, d.machining),
	};
}

/** The setup half of the Record form's live state: each section's keys come from the defaults, so
 *  per-cut fields on the same objects are never picked up. */
export function pickSetup(src: Record<keyof SetupPrefs, object>): SetupPrefs {
	const d = defaultSetupPrefs();
	const pick = <T extends object>(o: object, shape: T): T =>
		Object.fromEntries(Object.keys(shape).map((k) => [k, (o as Record<string, unknown>)[k]])) as T;
	return { cfg: pick(src.cfg, d.cfg), link: pick(src.link, d.link), meta: pick(src.meta, d.meta), machining: pick(src.machining, d.machining) };
}

export function loadSetupPrefs(): SetupPrefs {
	try { return parseSetupPrefs(localStorage.getItem(SETUP_PREFS_KEY)); } catch { return defaultSetupPrefs(); }
}

/** Writes the setup, or removes the entry when it is all defaults (so "Clear setup" leaves nothing behind). */
export function saveSetupPrefs(p: SetupPrefs): void {
	try {
		const json = JSON.stringify(p);
		if (json === JSON.stringify(defaultSetupPrefs())) localStorage.removeItem(SETUP_PREFS_KEY);
		else localStorage.setItem(SETUP_PREFS_KEY, json);
	} catch { /* storage full or blocked: not worth an error */ }
}

export function clearSetupPrefs(): void {
	try { localStorage.removeItem(SETUP_PREFS_KEY); } catch { /* blocked: nothing stored anyway */ }
}
