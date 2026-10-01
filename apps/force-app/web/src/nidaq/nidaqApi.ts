// Frontend helpers for the backend's /nidaq/* endpoints (chassis enumeration + channel model).
// The backend enumerates real hardware on the rig, or a simulated chassis on dev machines.
import { JSON_HEADERS, readJson as j, recorderBase as base } from '../recorderHttp';

export type Connector = 'bnc' | 'terminal' | 'dsub';
export interface Port { id: string; kind: 'ai' | 'ci'; physical: string; }
export interface Module { name: string; product_type: string; label: string; slot: number; connector: Connector; note: string; iepe: boolean; ports: Port[]; }
export interface Chassis { name: string; product_type: string; slots: number; modules: Module[]; }
export interface Devices { simulated: boolean; chassis: Chassis[]; standalone: Module[]; }
export interface Channel { name: string; role: string; physical: string | null; sensitivity_pc_per_n: number | null; gain_n_per_v: number | null; source: 'hardware' | 'virtual'; formula?: string | null; color: string; }
export interface FormulaValidation { valid: boolean; error?: string; references?: string[]; }
export interface CatalogCard { product_type: string; label: string; connector: Connector; ai: number; ci: number; note?: string; vmax?: number; ks?: number; iepe?: boolean; }
export interface ChannelsResp { channels: Channel[]; roles: string[]; colors: Record<string, string>; }

export const nidaqApi = {
	devices: () => fetch(`${base()}/nidaq/devices`).then(j<Devices>),
	catalog: () => fetch(`${base()}/nidaq/catalog`).then(j<{ cards: CatalogCard[] }>),
	addCard: (slot: number, product_type: string) =>
		fetch(`${base()}/nidaq/sim/card`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ slot, product_type }) }).then(j<Devices>),
	removeCard: (slot: number) =>
		fetch(`${base()}/nidaq/sim/card?slot=${slot}`, { method: 'DELETE' }).then(j<Devices>),
	getChannels: () => fetch(`${base()}/nidaq/channels`).then(j<ChannelsResp>),
	putChannels: (channels: Channel[]) =>
		fetch(`${base()}/nidaq/channels`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ channels }) }).then(j<{ channels: Channel[] }>),
	autoassign: () => fetch(`${base()}/nidaq/channels/autoassign`, { method: 'POST' }).then(j<{ channels: Channel[] }>),
	validateFormula: (formula: string) =>
		fetch(`${base()}/nidaq/channels/validate-formula`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ formula }) }).then(j<FormulaValidation>),
};

// Referenceable in a virtual-channel formula regardless of what's actually configured — the 8 dyno
// sub-channels, Tacho, and the 3 summed axes always exist. Real (hardware) Aux channels are ALSO
// referenceable but are data-dependent, so they come from the live channel list, not this constant.
export const CORE_REFERENCEABLE = ['Fx1', 'Fx2', 'Fy1', 'Fy2', 'Fz1', 'Fz2', 'Fz3', 'Fz4', 'Tacho', 'Fx', 'Fy', 'Fz'] as const;

export const ROLE_COLORS: Record<string, string> = { Fx: '#f87171', Fy: '#4ade80', Fz: '#60a5fa', Tacho: '#c084fc', Aux: '#fbbf24', Virtual: '#38bdf8' };
