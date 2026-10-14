// A list's accent colour: a column some collections carry per row (the ISO classes' `colour_hex`, VARCHAR(7)),
// which the cards use as a stripe and a swatch. The value comes from the database and ends up in a style, so
// only a plain #rrggbb is ever used; anything else (null, a named colour, a url, injected CSS) is no accent.

import type { IndexDef } from './indexConfig';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The colour when it is a #rrggbb string, else null. */
export function accentColour(value: unknown): string | null {
	return typeof value === 'string' && HEX.test(value) ? value : null;
}

/** The row's accent colour for a list that has an `accentField`, else null. */
export function rowAccent(def: IndexDef, row: Record<string, unknown>): string | null {
	return def.accentField ? accentColour(row[def.accentField]) : null;
}
