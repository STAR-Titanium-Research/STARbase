/** Pure helpers for the "Download CSV" answer action (RFC 4180, UTF-8 BOM for Excel). */

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Spreadsheet formula guard: a text cell starting with = + - @ tab or CR is run as a formula by
 * Excel / Sheets, so it gets a leading apostrophe. Plain-number strings are left alone (Postgres
 * numerics arrive as strings, and negatives must stay numeric).
 */
export function guardFormula(text: string): string {
	return /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

/** One cell as text: null, undefined and NaN/Infinity become empty; objects become JSON. */
export function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
	if (typeof value === 'object') return JSON.stringify(value);
	return guardFormula(String(value));
}

/** Quote a field only when it has to be: a comma, a double quote, CR or LF. */
export function csvField(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole file body: header row, then one CRLF-terminated line per row, after a BOM. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
	const lines = [columns.map((c) => csvField(guardFormula(c))).join(',')];
	for (const row of rows) lines.push(columns.map((c) => csvField(csvCell(row[c]))).join(','));
	return '﻿' + lines.join('\r\n') + '\r\n';
}

function localDate(d: Date): string {
	const p2 = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** `ask-<question slug>-<yyyy-mm-dd>.csv` (the date in the browser's local time); the slug is capped so the name stays short. */
export function csvFilename(question: string, date: Date = new Date()): string {
	const slug =
		question
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 50)
			.replace(/-+$/, '') || 'answer';
	return `ask-${slug}-${localDate(date)}.csv`;
}
