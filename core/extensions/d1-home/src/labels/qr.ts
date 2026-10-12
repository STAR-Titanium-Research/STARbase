import QRCode from 'qrcode';
import type { QrLevel, QrModules } from '@d1/ui';

// QR modules for a payload at an error-correction level (the renderer asks for M, then L when M's modules
// would be too small on the label), remembered by level and payload: typing in the template editor re-renders
// every label on each pause, and the codes do not change when only the layout does. The cache is bounded (a
// long session with many samples must not grow it for ever).
const cache = new Map<string, QrModules>();
const MAX = 2000;

export function qrModules(payload: string, level: QrLevel = 'M'): QrModules {
	const key = `${level}\n${payload}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const { size, data } = QRCode.create(payload, { errorCorrectionLevel: level }).modules;
	const modules: QrModules = { size, data };
	if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
	cache.set(key, modules);
	return modules;
}
