// Defensive readers for what the Record page keeps in localStorage. Persisted data outlives
// releases (invariant 11), so a value written by another version, or damaged, must degrade to
// "use what is good" and never throw during setup.

interface LayoutItem { i: string; type: string; x: number; y: number; w: number; h: number }

/**
 * The saved Record layout with every entry that is not usable dropped: a panel type this version
 * does not know (a newer or older release saved it), or one without a grid position. Unknown types
 * are skipped, not fatal: one used to discard the WHOLE layout and reset the operator's
 * arrangement. An empty saved layout (all panels closed) is kept; `null` means nothing usable, so
 * the caller falls back to its default.
 */
export function parseSavedLayout<T extends LayoutItem>(raw: string | null, knownTypes: Record<string, unknown>): T[] | null {
	let parsed: unknown;
	try { parsed = JSON.parse(raw || 'null'); } catch { return null; }
	if (!Array.isArray(parsed)) return null;
	const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	const kept = parsed.filter((x): x is T => !!x && typeof x === 'object'
		&& typeof (x as any).i === 'string' && typeof (x as any).type === 'string'
		&& Object.prototype.hasOwnProperty.call(knownTypes, (x as any).type)
		&& num((x as any).x) && num((x as any).y) && num((x as any).w) && num((x as any).h));
	// Entries existed but none survived: nothing to show, so the default layout is better than a blank page.
	return kept.length === 0 && parsed.length > 0 ? null : kept;
}

/** The ids the operator dismissed from the recovery banner; an unreadable value is "none". */
export function parseDismissedIds(raw: string | null): Set<string> {
	try {
		const v = JSON.parse(raw || '[]');
		return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	} catch {
		return new Set();
	}
}
