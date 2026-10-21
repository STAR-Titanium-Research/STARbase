// Test helpers for the Conform log fixture (node only; imported by the *.test.ts files).
import { readFileSync } from 'node:fs';

export const fixtureText = readFileSync(new URL('./tiswarf-excerpt.csv', import.meta.url), 'utf8');

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
