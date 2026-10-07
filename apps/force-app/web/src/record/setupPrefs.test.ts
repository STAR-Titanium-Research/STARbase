import { describe, expect, it } from 'vitest';
import { defaultSetupPrefs, parseSetupPrefs, saveSetupPrefs, SETUP_PREFS_KEY } from './setupPrefs';

describe('parseSetupPrefs (R1)', () => {
	it('gives the defaults with nothing stored, or junk', () => {
		expect(parseSetupPrefs(null)).toEqual(defaultSetupPrefs());
		expect(parseSetupPrefs('not json')).toEqual(defaultSetupPrefs());
		expect(parseSetupPrefs('[1,2]')).toEqual(defaultSetupPrefs());
		expect(parseSetupPrefs('42')).toEqual(defaultSetupPrefs());
		expect(parseSetupPrefs('{"cfg":5,"link":[],"meta":null}')).toEqual(defaultSetupPrefs());
	});

	it('round-trips valid values', () => {
		const p = {
			cfg: { rpm: 900, feed: 0.2, diam: 40, inner_diam: 5, sample_rate: 10000, ppr: 2 },
			link: { sampleId: 's1', sampleLabel: 'S-1', operatorId: 'p1', operatorLabel: 'Pat', equipmentId: 'e1', equipmentLabel: 'Lathe' },
			meta: { sample_name: 'S-1', sample_code: 'S-1', op_type: 'MT-F', coolant: 'flood' },
			machining: { axial_doc: '1', radial_doc: '2', cutting_length: '30', coolant_pressure: '4' },
		};
		expect(parseSetupPrefs(JSON.stringify(p))).toEqual(p);
	});

	it('replaces each bad field with its default and keeps the good ones', () => {
		const d = defaultSetupPrefs();
		const p = parseSetupPrefs(JSON.stringify({
			cfg: { rpm: 'fast', feed: null, diam: -3, inner_diam: 12, sample_rate: 0, ppr: 0.5 },
			link: { sampleId: 5, sampleLabel: 'S-1' },
			meta: { op_type: ['MT-F'], coolant: 'mist' },
		}));
		expect(p.cfg).toEqual({ ...d.cfg, inner_diam: 12 });
		expect(p.link.sampleId).toBe('');
		expect(p.link.sampleLabel).toBe('S-1');
		expect(p.meta.op_type).toBe('');
		expect(p.meta.coolant).toBe('mist');
	});

	it('rejects NaN (stored as null) numbers', () => {
		const p = parseSetupPrefs('{"cfg":{"rpm":null,"feed":null}}');
		expect(p.cfg.rpm).toBe(defaultSetupPrefs().cfg.rpm);
		expect(p.cfg.feed).toBe(defaultSetupPrefs().cfg.feed);
	});

	it('does not remember insert, edge or tool (they turn over every cut)', () => {
		const p = parseSetupPrefs(JSON.stringify({ meta: { insert: 'I', edge_id: 'E', tool: 'T', coolant: 'flood' } }));
		expect(p.meta).toEqual({ ...defaultSetupPrefs().meta, coolant: 'flood' });
		expect(JSON.stringify(defaultSetupPrefs())).not.toMatch(/insert|edge_id|tool/);
	});

	it('never reads per-cut fields, or unknown keys, even if they are stored', () => {
		const p = parseSetupPrefs(JSON.stringify({
			meta: { notes: 'n', operation: 'pass', evil: 1 },
			machining: { operation_sequence: '3', chips_ref: 'c', chips_collected: true, new_edge: true },
		}));
		expect(p.meta).toEqual(defaultSetupPrefs().meta);
		expect(p.machining).toEqual(defaultSetupPrefs().machining);
		expect(JSON.stringify(p)).not.toMatch(/notes|operation|chips|new_edge|evil|duration/);
	});
});

describe('saveSetupPrefs (R1)', () => {
	function stub() {
		const m = new Map<string, string>();
		(globalThis as any).localStorage = {
			getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); },
		};
		return m;
	}
	it('stores a changed setup and removes the entry when it is all defaults', () => {
		const m = stub();
		const p = defaultSetupPrefs(); p.cfg.rpm = 800;
		saveSetupPrefs(p);
		expect(JSON.parse(m.get(SETUP_PREFS_KEY)!).cfg.rpm).toBe(800);
		saveSetupPrefs(defaultSetupPrefs());
		expect(m.has(SETUP_PREFS_KEY)).toBe(false);
	});
});
