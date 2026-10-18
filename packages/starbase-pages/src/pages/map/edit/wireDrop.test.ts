import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import type { SocketRef } from './socketRefs';
import { dropVerdict, wireOf } from './wireDrop';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const sample = (id: string, side: 'in' | 'out'): SocketRef => ({ kind: 'sample', id, side });
const row = (id: string, side: 'in' | 'out'): SocketRef => ({ kind: 'row', id, side });

/** n1 a new sample; n2 a free operation (row n3); n4 a free test; n5 another new sample. */
const body = (): DraftBody =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } },
		{ type: 'addSample' },
	]);

describe('dropping a wire on a socket', () => {
	it('lets a sample output go to a free operation input, whichever end was dragged', () => {
		const forward = dropVerdict(body(), sample('draft:n1', 'out'), row('draft:n3', 'in'));
		expect(forward.ok).toBe(true);
		expect(forward.from).toEqual(sample('draft:n1', 'out'));
		const backward = dropVerdict(body(), row('draft:n3', 'in'), sample('draft:n1', 'out'));
		expect(backward.ok).toBe(true);
		expect(backward.from).toEqual(sample('draft:n1', 'out'));
		expect(backward.to).toEqual(row('draft:n3', 'in'));
	});

	it('lets a sample go to a test', () => {
		expect(dropVerdict(body(), sample('draft:n1', 'out'), row('draft:n4', 'in')).ok).toBe(true);
	});

	it('lets an operation output go to a new sample, which makes it', () => {
		expect(dropVerdict(body(), row('draft:n3', 'out'), sample('draft:n5', 'in')).ok).toBe(true);
	});

	it('refuses two outputs and two inputs, in words', () => {
		expect(dropVerdict(body(), sample('draft:n1', 'out'), row('draft:n3', 'out'))).toMatchObject({ ok: false, reason: 'Drop an output on an input socket.' });
		expect(dropVerdict(body(), row('draft:n3', 'in'), row('draft:n4', 'in'))).toMatchObject({ ok: false, reason: 'Drop an input on an output socket.' });
	});

	it("gives the reducer's own reason when the pair does not fit", () => {
		expect(dropVerdict(body(), sample('draft:n1', 'out'), sample('draft:n5', 'in')).reason).toBe('Samples are joined through an operation: add one between them.');
		expect(dropVerdict(body(), row('draft:n4', 'out'), sample('draft:n5', 'in')).reason).toBe('A test has no output to wire on.');
		const wired = run([{ type: 'wire', from: { key: 'n1' }, to: { key: 'n2', row: 0 } }], body());
		expect(dropVerdict(wired, sample('draft:n5', 'out'), row('draft:n3', 'in')).reason).toBe('That input already has a sample.');
		expect(dropVerdict(wired, sample('draft:n1', 'out'), row('draft:n3', 'in')).reason).toBe('Those two are already wired.');
	});

	it('refuses a circle', () => {
		const chain = run([
			{ type: 'wire', from: { key: 'n1' }, to: { key: 'n2', row: 0 } },
			{ type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n5' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n5' } },
		], body());
		const second = chain.items.find((i) => i.kind === 'operation' && i.key !== 'n2')!;
		const secondRow = (second as { rows: { key: string }[] }).rows[0].key;
		expect(dropVerdict(chain, row(`draft:${secondRow}`, 'out'), sample('draft:n1', 'in')).ok).toBe(false);
	});

	it('tries a sample of the loaded history as if the draft held it', () => {
		const ok = dropVerdict(body(), sample('old-sample', 'out'), row('draft:n3', 'in'));
		expect(ok.ok).toBe(true);
		expect(ok.from).toEqual(sample('old-sample', 'out'));
	});

	it('refuses a loaded sample as the one an operation makes', () => {
		const v = dropVerdict(body(), row('draft:n3', 'out'), sample('old-sample', 'in'));
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/already exists with its own history/);
	});

	it('refuses a recorded operation that is not in the draft', () => {
		const v = dropVerdict(body(), sample('draft:n1', 'out'), row('recorded-op', 'in'));
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/recorded already/);
	});

	it('is a wire of resolved ends once the body holds both cards', () => {
		const v = dropVerdict(body(), sample('draft:n1', 'out'), row('draft:n3', 'in'));
		expect(wireOf(body(), v)).toEqual({ from: { key: 'n1' }, to: { key: 'n2', row: 0 } });
		expect(wireOf(body(), { ok: false })).toBeNull();
		const old = dropVerdict(body(), sample('old-sample', 'out'), row('draft:n3', 'in'));
		expect(wireOf(body(), old)).toBeNull(); // the page adds the sample first, then asks again
		const added = apply(body(), { type: 'addExistingSamples', samples: [{ id: 'old-sample', version: 2 }] });
		expect(wireOf(added, old)).toEqual({ from: { key: 'n6' }, to: { key: 'n2', row: 0 } });
	});
});
