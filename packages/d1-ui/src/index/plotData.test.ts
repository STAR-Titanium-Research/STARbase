import { describe, expect, it } from 'vitest';
import { mergePlots, plotKind, plotRequests } from './plotData';

const ids = ['a', 'b', 'c', 'd'];

describe('plotKind', () => {
	it('is only set for the operations and samples lists', () => {
		expect(plotKind('manufacturing_operations')).toBe('operations');
		expect(plotKind('physical_samples')).toBe('samples');
		expect(plotKind('tools')).toBeNull();
	});
});

describe('plotRequests', () => {
	it('asks for done force and FAST rows of the operations on screen, with an _in list and no _some', () => {
		const reqs = plotRequests('manufacturing_operations', ids);
		expect(reqs.map((r) => [r.key, r.path])).toEqual([
			['force', '/items/machining_force_analysis'],
			['fast', '/items/fast_run_data'],
			['conform', '/items/conform_run_data'],
		]);
		const done = JSON.stringify({ _and: [{ operation_id: { _in: ids } }, { status: { _eq: 'done' } }] });
		expect(reqs[0].params).toMatchObject({ filter: done, fields: ['operation_id', 'frm_fz'], limit: -1 });
		expect(reqs[1].params).toMatchObject({ filter: done, fields: ['operation_id'], limit: -1 });
		// A Conform run is plotted once a log is linked: there is no status to wait for.
		expect(reqs[2].params).toMatchObject({
			filter: JSON.stringify({ _and: [{ operation_id: { _in: ids } }, { log_id: { _nnull: true } }] }),
			fields: ['operation_id'],
			limit: -1,
		});
		expect(JSON.stringify(reqs)).not.toContain('_some');
	});

	it('asks for the done force rows reaching the samples on screen, through their operations', () => {
		const reqs = plotRequests('physical_samples', ['s1', 's2']);
		expect(reqs).toHaveLength(1);
		expect(reqs[0].key).toBe('sampleForce');
		expect(reqs[0].path).toBe('/items/machining_force_analysis');
		expect(reqs[0].params).toMatchObject({
			filter: JSON.stringify({ _and: [{ status: { _eq: 'done' } }, { operation_id: { sample_id: { _in: ['s1', 's2'] } } }] }),
			fields: ['operation_id.operation_id', 'operation_id.sample_id'],
			limit: -1,
		});
		expect(JSON.stringify(reqs)).not.toContain('_some');
	});

	it('asks for nothing for other lists or no rows', () => {
		expect(plotRequests('tools', ids)).toEqual([]);
		expect(plotRequests('manufacturing_operations', [])).toEqual([]);
		expect(plotRequests('physical_samples', [])).toEqual([]);
	});
});

describe('mergePlots (operations)', () => {
	const op = 'manufacturing_operations';

	it('marks the operations that have done rows, and keeps the first Fz figure', () => {
		// 4 operations; 2 have a done force row (b has two, only the second carries a figure); c has a done FAST row.
		const plots = mergePlots(op, ids, {
			force: [{ operation_id: 'a', frm_fz: 'file-a' }, { operation_id: 'b', frm_fz: null }, { operation_id: 'b', frm_fz: { id: 'file-b' } }],
			fast: [{ operation_id: 'c' }],
		});
		expect(Object.keys(plots)).toEqual(ids);
		expect(plots.a).toEqual({ force: true, fast: false, frmFz: 'file-a' });
		expect(plots.b).toEqual({ force: true, fast: false, frmFz: 'file-b' });
		expect(plots.c).toEqual({ force: false, fast: true, frmFz: null });
		expect(plots.d).toEqual({ force: false, fast: false, frmFz: null });
	});

	it('marks the Conform runs that have a log, and only those', () => {
		const plots = mergePlots(op, ids, { conform: [{ operation_id: 'd' }] });
		expect(plots.d).toEqual({ force: false, fast: false, conform: true, frmFz: null });
		expect(plots.a).toEqual({ force: false, fast: false, frmFz: null });
		expect(mergePlots(op, ids, { conform: null }).d.conform).toBeUndefined();
	});

	it('shows no buttons of a kind whose request failed (null) or did not run', () => {
		const plots = mergePlots(op, ids, { force: null, fast: [{ operation_id: 'a' }] });
		expect(plots.a).toEqual({ force: false, fast: true, frmFz: null });
		expect(plots.b.force).toBe(false);
		const none = mergePlots(op, ids, {});
		expect(none.a).toEqual({ force: false, fast: false, frmFz: null });
	});

	it('ignores rows of operations that are not on the page', () => {
		const plots = mergePlots(op, ['a'], { force: [{ operation_id: 'zzz', frm_fz: 'x' }] });
		expect(plots).toEqual({ a: { force: false, fast: false, frmFz: null } });
	});
});

describe('mergePlots (samples)', () => {
	const sm = 'physical_samples';

	it('counts the distinct operations with a done force analysis per sample', () => {
		const plots = mergePlots(sm, ['s1', 's2', 's3'], {
			sampleForce: [
				{ operation_id: { operation_id: 'o1', sample_id: 's1' } },
				{ operation_id: { operation_id: 'o1', sample_id: 's1' } }, // two analyses of one operation count once
				{ operation_id: { operation_id: 'o2', sample_id: 's1' } },
				{ operation_id: { operation_id: 'o3', sample_id: 's2' } },
				{ operation_id: null },
			],
		});
		expect(plots.s1).toEqual({ force: true, fast: false, frmFz: null, forceCount: 2 });
		expect(plots.s2).toEqual({ force: true, fast: false, frmFz: null, forceCount: 1 });
		expect(plots.s3).toEqual({ force: false, fast: false, frmFz: null, forceCount: 0 });
	});

	it('shows nothing when the request failed', () => {
		const plots = mergePlots(sm, ['s1'], { sampleForce: null });
		expect(plots.s1).toEqual({ force: false, fast: false, frmFz: null, forceCount: 0 });
	});
});
