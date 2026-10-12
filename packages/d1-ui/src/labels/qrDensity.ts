// How big a QR module (one dark or light square) ends up on the label, and which error-correction level to
// draw. The payload is long (150 to 200 characters), so on a small label the modules get small; a phone
// camera reads a module down to about 0.3 mm, with margin from 0.33 mm.
import { QUIET_MODULES, type QrModules } from './qrSvg';

export type QrLevel = 'M' | 'L';

// Error correction M (about 15% of the code can be damaged) is used while the modules stay at least this big.
export const MIN_MODULE_MM = 0.33;
// Under this a code is flagged as hard to scan, even at the lowest level (L).
export const WARN_MODULE_MM = 0.3;

// One module in mm: the QR box edge shared by the modules and the quiet zone round them (qrSvg draws both).
export function moduleMm(boxMm: number, modules: number): number {
	return boxMm / (modules + 2 * QUIET_MODULES);
}

export interface ChosenQr {
	modules: QrModules;
	level: QrLevel;
	moduleMm: number;
}

// M when its modules are big enough, else L (fewer modules, so each is bigger). `qr` builds the matrix for a
// payload at a level (QRCode.create(payload, { errorCorrectionLevel })).
export function chooseQr(payload: string, boxMm: number, qr: (payload: string, level: QrLevel) => QrModules): ChosenQr {
	const m = qr(payload, 'M');
	const mmM = moduleMm(boxMm, m.size);
	if (mmM >= MIN_MODULE_MM) return { modules: m, level: 'M', moduleMm: mmM };
	const l = qr(payload, 'L');
	return { modules: l, level: 'L', moduleMm: moduleMm(boxMm, l.size) };
}
