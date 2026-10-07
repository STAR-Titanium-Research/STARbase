// FRM signal-filter chain: types, defaults, hashing, and filter-service calls
// (docs/superpowers/specs/2026-07-21-frm-filtering-suite-design.md). The chain JSON shape
// is shared verbatim with the filter-service (scipy) and MATLAB frm_filters (bake).
import { type Cache, parseCache } from './liveCache';
import { authorizedFetch, useForceHost } from './host';
import { diagRequestError } from './diagError';

export interface FilterChain {
	despike: { on: boolean; window: number; sigma: number };
	detrend: { on: boolean; mode: 'dc' | 'highpass'; cutoff_hz: number };
	highpass: { on: boolean; cutoff_hz: number; order: number };
	lowpass: { on: boolean; cutoff_hz: number; order: number };
	notch: { on: boolean; harmonics: number[]; q: number };
}

export function defaultChain(): FilterChain {
	return {
		despike: { on: false, window: 11, sigma: 5 },
		detrend: { on: false, mode: 'highpass', cutoff_hz: 5 },
		highpass: { on: false, cutoff_hz: 50, order: 4 },
		lowpass: { on: false, cutoff_hz: 2000, order: 4 },
		notch: { on: false, harmonics: [1, 2, 3], q: 30 },
	};
}

export function chainActive(c: FilterChain | null | undefined): boolean {
	return !!c && (c.despike.on || c.detrend.on || c.highpass.on || c.lowpass.on || c.notch.on);
}

export function chainSummary(c: FilterChain | null | undefined): string {
	if (!c) return '';
	const s: string[] = [];
	if (c.despike.on) s.push(`despike ${c.despike.sigma}σ`);
	if (c.detrend.on) s.push(c.detrend.mode === 'dc' ? 'DC removal' : `detrend ${c.detrend.cutoff_hz} Hz`);
	if (c.highpass.on) s.push(`HP ${c.highpass.cutoff_hz} Hz`);
	if (c.lowpass.on) s.push(`LP ${c.lowpass.cutoff_hz} Hz`);
	if (c.notch.on) s.push(`notch ${c.notch.harmonics.join(',')}× Q${c.notch.q}`);
	return s.join(' · ');
}

// ---- filter-service calls. Same-origin via Caddy /filter/* under Directus (session cookie
// flows automatically); cross-origin with a Bearer token in the standalone app, which the
// service forwards to Directus when fetching the cache. The host supplies both. ----
export async function fetchFiltered(cacheFileId: string, chain: FilterChain, targetPoints = 1_500_000, signal?: AbortSignal):
	Promise<{ cache: Cache; skipped: string[]; stride: number }> {
	const res = await authorizedFetch(`${useForceHost().filterUrl}/run`, {
		method: 'POST',
		signal,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cache_file_id: cacheFileId, chain, target_points: targetPoints }),
	});
	if (!res.ok) throw diagRequestError('filter', res.status, await res.text());
	const skipped = (res.headers.get('X-Filter-Skipped') || '').split(';').map((s) => s.trim()).filter(Boolean);
	const stride = Math.max(1, parseInt(res.headers.get('X-Filter-Stride') || '1', 10) || 1);
	return { cache: parseCache(await res.arrayBuffer()), skipped, stride };
}

export async function fetchFilteredFft(cacheFileId: string, chain: FilterChain, axis: string, signal?: AbortSignal):
	Promise<{ f: number[]; amp: number[] }> {
	const res = await authorizedFetch(`${useForceHost().filterUrl}/fft`, {
		method: 'POST',
		signal,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cache_file_id: cacheFileId, chain, axis }),
	});
	if (!res.ok) throw diagRequestError('FFT', res.status, await res.text());
	return res.json();
}

// STFT of one axis for the spectrogram / waterfall / power-spectrum views. S is [freq][time] in dB.
export async function fetchSpectrogram(cacheFileId: string, chain: FilterChain, axis: string, signal?: AbortSignal):
	Promise<{ f: number[]; t: number[]; S: number[][]; fmax: number }> {
	const res = await authorizedFetch(`${useForceHost().filterUrl}/spectrogram`, {
		method: 'POST',
		signal,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cache_file_id: cacheFileId, chain, axis }),
	});
	if (!res.ok) throw diagRequestError('spectrogram', res.status, await res.text());
	return res.json();
}
