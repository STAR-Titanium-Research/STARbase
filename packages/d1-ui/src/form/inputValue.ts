// Text <-> value for the form's inputs, kept out of the components so it is tested on its own.
//
// An <input> holds text; a record holds typed values. A blank input is null (never ''), numbers are numbers,
// a date-time input is local time and a `timestamp` column is stored as UTC (Data Studio does the same), a
// `dateTime` column has no zone and is stored as typed.

import { isEmptyValue } from './fieldModel';
import type { FormField } from './fieldModel';

const pad = (n: number): string => String(n).padStart(2, '0');
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/** What an input shows for a stored value: '' when there is none. */
export function inputText(field: Pick<FormField, 'kind' | 'type'>, value: unknown): string {
	if (isEmptyValue(value)) return '';
	const v = String(value);
	switch (field.kind) {
		case 'date':
			return v.slice(0, 10);
		case 'time':
			return v.slice(0, 8);
		case 'datetime': {
			if (!v.includes('T') && !v.includes(' ')) return `${v.slice(0, 10)}T00:00`;
			if (HAS_ZONE.test(v)) {
				const d = new Date(v);
				if (Number.isNaN(d.getTime())) return v.slice(0, 16);
				return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
			}
			return v.replace(' ', 'T').slice(0, 16);
		}
		default:
			return v;
	}
}

/** The stored value for what an input holds: null for blank text or a number that is not one. */
export function parseInput(field: Pick<FormField, 'kind' | 'type' | 'integer'>, text: string): unknown {
	const t = text.trim();
	if (t === '') return null;
	switch (field.kind) {
		case 'number': {
			const n = Number(t);
			// An integer column has no decimals: 1.5 is refused (null), not rounded behind the person's back.
			if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) return null;
			return n;
		}
		case 'time':
			return t.length === 5 ? `${t}:00` : t;
		case 'datetime': {
			if (field.type === 'timestamp') {
				const d = new Date(t);
				return Number.isNaN(d.getTime()) ? null : d.toISOString();
			}
			return t.length === 16 ? `${t}:00` : t;
		}
		case 'text':
		case 'textarea':
			return text; // as typed: spaces inside a note are the person's
		default:
			return t;
	}
}

/** A value that is none of the choices, in a field that allows one (Surface Finish "Other..."). */
export function isOtherValue(field: Pick<FormField, 'allowOther' | 'choices'>, value: unknown): boolean {
	return field.allowOther && !isEmptyValue(value) && !field.choices.some((c) => String(c.value) === String(value));
}

/**
 * What is wrong with the text typed into a number field, or null: not a number, decimals in a whole-number field,
 * below `min` or above `max`. Out-of-range numbers are still stored (parseInput keeps them); the form flags them.
 */
export function inputProblem(field: Pick<FormField, 'kind' | 'integer' | 'min' | 'max'>, text: string): string | null {
	if (field.kind !== 'number') return null;
	const t = text.trim();
	if (t === '') return null;
	const n = Number(t);
	if (!Number.isFinite(n)) return 'Enter a number.';
	if (field.integer && !Number.isInteger(n)) return 'Whole numbers only.';
	if (field.min !== null && n < field.min) return `At least ${field.min}.`;
	if (field.max !== null && n > field.max) return `At most ${field.max}.`;
	return null;
}
