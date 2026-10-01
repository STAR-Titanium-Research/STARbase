// Frontend helper for the backend's /labamp/* endpoints (the backend proxies to the link-local
// Kistler amp; in dev it defaults to a mock so the UI works without hardware).
import { JSON_HEADERS, readJson as j, recorderBase as base } from '../recorderHttp';

export interface LabAmpStatus { reachable: boolean; mode: string | null; base_url: string; mock: boolean; channels: number; config_mode: string; }
export interface SensorRow { channel: number; name?: string; serialNumber?: string; physicalQuantity?: string; sensitivity?: number; range?: number; }
export interface LabAmpConfig { base_url: string; channels: number; mode: string; autorange_headroom?: number; nidaq_bits?: number; labamp_dac_bits?: number; analog_fullscale_v?: number; }
export interface AutoRangeRec { channel: number; peak: number; current: number | null; recommended: number; resolution: number; bits_used: number; gain_n_per_v: number; output_pct: number; would_clip: boolean; headroom: number; clipped?: boolean; }
export interface AutoRangeResult { headroom: number; nidaq_bits: number; dac_bits: number; effective_bits: number; fullscale_v: number; recommendations: AutoRangeRec[]; }
// Converging between-cuts auto-range: recommend (and optionally apply) the NEXT-pass ranges from the
// last recorded cut's per-channel peaks (summary.channels_ranging), not a live amp poll.
export interface ChannelsRanging { peaks_n: number[]; clipped: boolean[]; gains_n_per_v: number[]; ranges_n: number[]; fullscale_v: number; }
export interface ConvergeResult extends AutoRangeResult { applied: boolean; status: Record<string, string>; }
export interface RecentCapture { id: string; sample_name: string; duration_sec: number | null; peaks_n: number[]; }

export const labamp = {
	status: () => fetch(`${base()}/labamp/status`).then(j<LabAmpStatus>),
	setMode: (mode: 'MEASURE' | 'RESET') => fetch(`${base()}/labamp/mode`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ mode }) }).then(j<{ mode: string }>),
	sensors: () => fetch(`${base()}/labamp/sensors`).then(j<{ sensors: SensorRow[] }>),
	getConfig: () => fetch(`${base()}/labamp/config`).then(j<LabAmpConfig>),
	setConfig: (cfg: Partial<LabAmpConfig>) => fetch(`${base()}/labamp/config`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(cfg) }).then(j<LabAmpConfig>),
	exportUrl: () => `${base()}/labamp/export`,
	autorange: (headroom?: number) => fetch(`${base()}/labamp/autorange${headroom ? `?headroom=${headroom}` : ''}`).then(j<AutoRangeResult>),
	autorangeApply: (headroom: number) => fetch(`${base()}/labamp/autorange/apply`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ headroom }) }).then(j<{ applied: AutoRangeRec[]; status: Record<string, string> }>),
	converge: (body: { peaks: number[]; clipped?: boolean[]; currents?: number[]; headroom?: number; apply?: boolean }) =>
		fetch(`${base()}/labamp/autorange/converge`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then(j<ConvergeResult>),
	writeSensors: (updates: { channel: number; sensitivity?: number; range?: number }[]) =>
		fetch(`${base()}/labamp/sensors/write`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ updates }) }).then(j<{ ok: boolean; sensors: SensorRow[] }>),
	recentCaptures: (limit = 20, q = '') => fetch(`${base()}/captures/recent?limit=${limit}&q=${encodeURIComponent(q)}`).then(j<{ captures: RecentCapture[] }>),
};
