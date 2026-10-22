// Test helpers for the Conform log fixture (node only; imported by the *.test.ts files).
import { readFileSync } from 'node:fs';

export const expected = JSON.parse(readFileSync(new URL('./synthetic-log.expected.json', import.meta.url), 'utf8')) as {
	n: number; duration_s: number; extruding_s: number; mean_wheel: number; mean_torque: number; mean_t1: number;
	peak_torque: number; peak_current: number; peak_t1: number; peak_wheel_temp: number; sub_window_298_end_energy: number;
	energy: { motor: number; ips: number; cooling: number; total: number };
	steps: { start: string; rows: number; rpm: number; t1: number[]; mean_torque: number; energy: number }[];
};

export const fixtureText = readFileSync(new URL('./synthetic-log.csv', import.meta.url), 'utf8');

// An Excel round trip of the fixture: mojibake degree signs, a BOM, CRLF, a junk and two computed columns, an
// annotated header and trailing empty lines.
export function excelVariant(text: string): string {
	const lines = text.trimEnd().split('\n');
	const header = lines[0]
		.replace(/°/g, 'Â°')
		.replace('Tooling Temperature 2 (Â°C)', 'Tooling Temperature 2 (Â°C) Die exit') + ',Column1,Pmotor,PIPS';
	const rows = lines.slice(1).map((l) => `${l},,1.5,0.1`);
	return '﻿' + [header, ...rows].join('\r\n') + '\r\n\r\n\r\n';
}
