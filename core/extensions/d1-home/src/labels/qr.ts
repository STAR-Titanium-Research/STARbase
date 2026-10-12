import QRCode from 'qrcode';
import type { QrModules } from '@d1/ui';

// QR modules for a payload, with error correction M, remembered by payload: typing in the template editor
// re-renders every label on each pause, and the codes do not change when only the layout does. The cache
// is bounded (a long session with many samples must not grow it for ever).
const cache = new Map<string, QrModules>();
const MAX = 2000;

export function qrModules(payload: string): QrModules {
	const hit = cache.get(payload);
	if (hit) return hit;
	const { size, data } = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules;
	const modules: QrModules = { size, data };
	if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
	cache.set(payload, modules);
	return modules;
}
