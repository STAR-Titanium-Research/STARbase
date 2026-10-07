// CSV export helpers shared by the Plot dashboard's tables (signal statistics, wear trend,
// diagnostics clusters) and the FRM PNG export. Pure text building plus one browser download
// path; the table views own their column lists, so units live in the header names (mean_fx_N).
import { ref } from 'vue';

export interface CsvColumn<T> {
	/** Header cell, units included (e.g. `mean_fx_N`). */
	header: string;
	/** Cell value; NaN, infinities, null and undefined export as an empty cell. */
	value: (row: T) => string | number | boolean | null | undefined;
}

// RFC 4180: quote a cell containing a comma, quote, CR or LF, doubling embedded quotes.
function cell(v: string | number | boolean | null | undefined): string {
	if (v == null) return '';
	if (typeof v === 'number' && !Number.isFinite(v)) return '';
	const s = String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row plus one line per row, CRLF-separated and CRLF-terminated (RFC 4180). */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
	const lines = [columns.map((c) => cell(c.header)).join(',')];
	for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','));
	return lines.join('\r\n') + '\r\n';
}

/** Make a string safe to embed in a download filename (operation tags can hold `/` or spaces). */
export function safeFilePart(s: string | null | undefined): string {
	return String(s ?? '').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Save a Blob through a temporary `<a download>`. Shared with the FRM PNG export. */
export function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = filename;
	document.body.appendChild(a); a.click(); a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
	// A BOM lets Excel read UTF-8 CSV without mangling non-ASCII characters.
	const bom = mime.startsWith('text/csv') ? '﻿' : '';
	downloadBlob(new Blob([bom + text], { type: mime }), filename);
}

/** Copy via a hidden textarea and `document.execCommand('copy')`: the only route on an http host,
 *  where `navigator.clipboard` does not exist (it needs a secure context). */
function legacyCopy(text: string): boolean {
	// Selecting the textarea moves focus to it; hand focus back to the Copy button afterwards so
	// keyboard users are not dropped onto <body>.
	const prevFocus = document.activeElement as HTMLElement | null;
	const ta = document.createElement('textarea');
	try {
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
		document.body.appendChild(ta);
		ta.focus(); ta.select();
		return document.execCommand('copy');
	} catch { return false; } finally {
		ta.remove();
		prevFocus?.focus?.();
	}
}

/** Copy text to the clipboard; resolves false when both the async Clipboard API and the
 *  `execCommand` fallback fail. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
	} catch { /* refused (permission): try the fallback */ }
	return legacyCopy(text);
}

/** A "Copy" button's action plus `copied` (true for 1.5 s after a successful copy) and `failed`
 *  (true for 1.5 s after both copy routes failed, so the button can say "Copy failed").
 *  Nothing is copied when `text()` is empty. */
export function useCopyFeedback(text: () => string) {
	const copied = ref(false);
	const failed = ref(false);
	async function copy() {
		const t = text();
		if (!t) return;
		const ok = await copyText(t);
		copied.value = ok; failed.value = !ok;
		setTimeout(() => { copied.value = false; failed.value = false; }, 1500);
	}
	return { copied, failed, copy };
}
