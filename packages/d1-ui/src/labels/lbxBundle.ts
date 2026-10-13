// The .lbx files of a label selection: one .lbx per label copy (a P-touch Editor file holds one label), named
// `<code>-<n>.lbx`, bundled into `labels-<date>.zip`; a single label is a bare .lbx. Also the rule for when
// the page offers the download at all.
import { zipSync, strToU8 } from 'fflate';
import { buildLbxLabelXml, buildPropXml, LBX_TAPE_MM } from './lbx';
import { isPrintableSample } from './sample';
import type { LabelEntry } from './page';
import type { LabelTemplate } from './types';

// Offered for the roll the .lbx is made for: a roll template whose label is as wide as the 62 mm tape.
export function isLbxTemplate(t: Pick<LabelTemplate, 'media' | 'labelWidthMm'> | null | undefined): boolean {
	return !!t && t.media === 'roll' && Math.abs(t.labelWidthMm - LBX_TAPE_MM) < 0.5;
}

export interface LbxDownload {
	filename: string;
	mime: string;
	bytes: Uint8Array;
	// .lbx files in it (1 is a bare .lbx, more are a .zip of them)
	labels: number;
	// Samples left out because they have no code or no valid short id (as the print leaves them out).
	invalid: number;
}

// A file name from a sample code: path and reserved characters and whitespace runs become "_".
export function lbxFileStem(code: string): string {
	const stem = code.replace(/[\/:*?"<>|\u0000-\u001F\s]+/g, '_').replace(/^[._]+|[._]+$/g, '');
	return (stem || 'label').slice(0, 80);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
// Local date, YYYY-MM-DD.
export const lbxDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const LBX_MIME = 'application/octet-stream';

// The .lbx (a zip of label.xml and prop.xml, in that order, deflated) for one label.
export function zipLbx(labelXml: string, propXml: string, mtime: Date): Uint8Array {
	return zipSync({ 'label.xml': [strToU8(labelXml), { level: 6, mtime }], 'prop.xml': [strToU8(propXml), { level: 6, mtime }] });
}

// `entries` are the selected samples with their copy counts. null when there is nothing to download.
export function buildLbxDownload(entries: LabelEntry[], t: LabelTemplate, contactEmail: string | null, now: Date = new Date()): LbxDownload | null {
	const files: { name: string; stem: string; bytes: Uint8Array }[] = [];
	const used = new Set<string>();
	let invalid = 0;
	for (const { sample, copies } of entries) {
		if (!isPrintableSample(sample)) {
			invalid++;
			continue;
		}
		const xml = buildLbxLabelXml(sample, t, contactEmail);
		const bytes = zipLbx(xml, buildPropXml(sample.code, now), now);
		for (let n = 1; n <= copies; n++) {
			let name = `${lbxFileStem(sample.code)}-${n}.lbx`;
			for (let k = 2; used.has(name.toLowerCase()); k++) name = `${lbxFileStem(sample.code)}-${n}_${k}.lbx`;
			used.add(name.toLowerCase());
			files.push({ name, stem: lbxFileStem(sample.code), bytes });
		}
	}
	if (!files.length) return null;
	if (files.length === 1) {
		// A single label is the bare file, named after the sample (no copy number).
		return { filename: `${files[0].stem}.lbx`, mime: LBX_MIME, bytes: files[0].bytes, labels: 1, invalid };
	}
	const zip: Record<string, [Uint8Array, { level: 0; mtime: Date }]> = {};
	// The .lbx files are zips already: stored, not deflated again.
	for (const f of files) zip[f.name] = [f.bytes, { level: 0, mtime: now }];
	return { filename: `labels-${lbxDate(now)}.zip`, mime: 'application/zip', bytes: zipSync(zip), labels: files.length, invalid };
}
