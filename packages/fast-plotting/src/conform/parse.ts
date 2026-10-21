// Parse a raw Conform machine log (1 Hz CSV, first column `Timestamp`, ISO-8601 UTC) into typed arrays.
import { catalogueOrder, classifyHeader, cleanHeader, ConformLogError, type ConformChannel } from './channels';

export interface ParsedConformLog {
	startMs: number; endMs: number; n: number;
	time: Float64Array;                                       // seconds from startMs
	channels: ConformChannel[]; values: Record<string, Float64Array>;
	ignored: string[]; nonNumeric: number; gaps: number;      // gaps = intervals > 1.5 s
}

const GAP_S = 1.5;
const ISO = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d+))?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/i;

/** Epoch ms (fractional) of an ISO-8601 timestamp; no zone means UTC. NaN when it is not one. */
export function parseIsoMs(s: string): number {
	const m = ISO.exec(s.trim());
	if (!m) return NaN;
	let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	if (m[7]) ms += +`0.${m[7]}` * 1000;
	const z = m[8];
	if (z && z.toUpperCase() !== 'Z') {
		const sign = z[0] === '-' ? -1 : 1;
		const digits = z.slice(1).replace(':', '');
		const off = +digits.slice(0, 2) * 60 + (digits.length > 2 ? +digits.slice(2, 4) : 0);
		ms -= sign * off * 60_000;
	}
	return ms;
}

function splitLine(line: string): string[] {
	if (!line.includes('"')) return line.split(',');
	const out: string[] = [];
	let cur = '';
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
		} else if (c === '"') q = true;
		else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
	}
	out.push(cur);
	return out;
}

const isBlankRow = (cells: string[]): boolean => cells.every((c) => c.trim() === '');

export function parseConformCsv(text: string): ParsedConformLog {
	const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
	let h = 0;
	while (h < lines.length && isBlankRow(splitLine(lines[h]))) h++;
	if (h >= lines.length) throw new ConformLogError('The file is empty.');

	const headerCells = splitLine(lines[h]).map(cleanHeader);
	const tsCol = headerCells.findIndex((c) => c.toLowerCase() === 'timestamp');
	if (tsCol < 0) throw new ConformLogError('This does not look like a Conform log: there is no Timestamp column.');

	// Which columns are kept, as channels, and which are ignored.
	const ignored: string[] = [];
	const kept: { col: number; channel: ConformChannel }[] = [];
	const seen = new Set<string>();
	headerCells.forEach((cell, col) => {
		if (col === tsCol) return;
		const c = classifyHeader(cell);
		if (c.kind === 'ignored' || seen.has(c.channel.key)) { if (cell) ignored.push(cell); return; }
		seen.add(c.channel.key);
		kept.push({ col, channel: c.channel });
	});
	if (!kept.length) throw new ConformLogError('No recognised channels were found in the log.');
	// Catalogue order (stable); pass-through channels follow in file order.
	kept.sort((a, b) => catalogueOrder(a.channel.key) - catalogueOrder(b.channel.key) || a.col - b.col);

	const rows: string[][] = [];
	for (let i = h + 1; i < lines.length; i++) {
		if (!lines[i]) continue;
		const cells = splitLine(lines[i]);
		if (!isBlankRow(cells)) rows.push(cells);
	}

	const cap = rows.length;
	const stamps = new Float64Array(cap);
	const cols = kept.map(() => new Float64Array(cap));
	let n = 0;
	let nonNumeric = 0;
	for (const cells of rows) {
		const ms = parseIsoMs(cells[tsCol] ?? '');
		if (Number.isNaN(ms)) { nonNumeric++; continue; }
		if (n > 0 && ms <= stamps[n - 1]) throw new ConformLogError(`The timestamps are not increasing (row ${n + 2}).`);
		stamps[n] = ms;
		for (let k = 0; k < kept.length; k++) {
			const raw = cells[kept[k].col];
			const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
			if (Number.isNaN(v)) nonNumeric++;
			cols[k][n] = v;
		}
		n++;
	}
	if (n < 2) throw new ConformLogError('The log needs at least two rows with a valid timestamp.');

	const startMs = stamps[0];
	const time = new Float64Array(n);
	let gaps = 0;
	for (let i = 0; i < n; i++) {
		time[i] = (stamps[i] - startMs) / 1000;
		if (i > 0 && time[i] - time[i - 1] > GAP_S) gaps++;
	}
	const values: Record<string, Float64Array> = {};
	kept.forEach((k, i) => { values[k.channel.key] = n === cap ? cols[i] : cols[i].slice(0, n); });
	return { startMs, endMs: stamps[n - 1], n, time, channels: kept.map((k) => k.channel), values, ignored, nonNumeric, gaps };
}
