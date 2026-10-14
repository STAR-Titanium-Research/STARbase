import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { inheritedValues, makerOf, sampleCodeFor, withSampleCodes, type InheritCtx } from './inherit';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()) => actions.reduce((b, a) => apply(b, a), from);

/** n1 sample (Ti64 disc) → n2 cut (method MC) → n4 new sample; n3 is the cut's row. */
const cut = () =>
	run([
		{ type: 'addSample', values: { material_id: 'mat-ti', form: 'disc' } },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
		{ type: 'addSample', from: { key: 'n2', row: 0 } },
	]);

const ctx: InheritCtx = {
	alloyCode: (m) => ({ 'mat-ti': 'Ti64' })[m],
	methodCode: (m) => ({ mc: 'MC', mf: 'MF' })[m],
	today: new Date(2026, 9, 14, 12),
};

describe('inheritedValues', () => {
	it('an output sample takes material and form from the input and its method from the operation', () => {
		expect(inheritedValues(cut(), 'n4', ctx)).toEqual({
			values: { material_id: 'mat-ti', form: 'disc', primary_method_id: 'mc' },
			from: { material_id: 'sample', form: 'sample', primary_method_id: 'operation' },
		});
	});

	it('leaves what the sample sets itself', () => {
		const b = apply(cut(), { type: 'setValues', key: 'n4', values: { form: 'bar', primary_method_id: 'mf' } });
		expect(inheritedValues(b, 'n4', ctx).values).toEqual({ material_id: 'mat-ti' });
	});

	it('reads an existing input sample from its loaded record', () => {
		const b = run([
			{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);
		const withRecord: InheritCtx = { ...ctx, record: (i) => (i.existing?.id === 's' ? { material_id: 'mat-ti', form: 'rod' } : undefined) };
		expect(inheritedValues(b, 'n4', withRecord).values).toEqual({ material_id: 'mat-ti', form: 'rod', primary_method_id: 'mc' });
		expect(inheritedValues(b, 'n4', ctx).values).toEqual({ primary_method_id: 'mc' });
	});

	it('follows an in-place chain back to the sample the cut took in', () => {
		let b = run([{ type: 'addSample', values: { material_id: 'mat-ti' } }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn' } }]);
		b = apply(b, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n2', row: 0 } });
		b = apply(b, { type: 'addSample', from: { key: 'n4', row: 0 } });
		expect(inheritedValues(b, 'n6', ctx).values.material_id).toBe('mat-ti');
	});

	it('a free new sample, an existing sample and an in-place sample inherit nothing', () => {
		const free = run([{ type: 'addSample' }]);
		expect(inheritedValues(free, 'n1', ctx).values).toEqual({});
		expect(inheritedValues(cut(), 'n1', ctx).values).toEqual({});
		expect(makerOf(cut(), 'n1')).toBeNull();
		expect(makerOf(cut(), 'n4')?.op.key).toBe('n2');
	});
});

describe('sample codes', () => {
	it('composes the template with the alloy of the inherited material, the operation method and the Create date', () => {
		expect(sampleCodeFor(cut(), 'n4', ctx)).toBe('{seq}-Ti64-MC-2026-10-14');
	});

	it('is empty while the alloy or the method is unknown, and for existing samples', () => {
		expect(sampleCodeFor(run([{ type: 'addSample' }]), 'n1', ctx)).toBe('');
		expect(sampleCodeFor(cut(), 'n4', { ...ctx, alloyCode: () => null })).toBe('');
		expect(sampleCodeFor(run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]), 'n1', ctx)).toBe('');
	});

	it('withSampleCodes writes the code into new samples, leaves real codes and unknowns alone, and keeps the old body when nothing changes', () => {
		const b = withSampleCodes(cut(), ctx);
		expect(b.items.find((i) => i.key === 'n4')?.values.sample_code).toBe('{seq}-Ti64-MC-2026-10-14');
		expect(b.items.find((i) => i.key === 'n1')?.values.sample_code).toBeUndefined();
		expect(withSampleCodes(b, ctx)).toBe(b);
		const real = apply(cut(), { type: 'setValues', key: 'n4', values: { sample_code: '12-X-Y-2020-1-1' } });
		expect(withSampleCodes(real, ctx)).toBe(real);
	});

	it('a code made on an earlier day is made again with the Create date', () => {
		const old = apply(cut(), { type: 'setValues', key: 'n4', values: { sample_code: '{seq}-Ti64-MC-2026-10-1' } });
		const b = withSampleCodes(old, ctx);
		expect(b.items.find((i) => i.key === 'n4')?.values.sample_code).toBe('{seq}-Ti64-MC-2026-10-14');
	});
});
