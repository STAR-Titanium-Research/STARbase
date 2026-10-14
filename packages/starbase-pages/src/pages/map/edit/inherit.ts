// E15, what a new sample inherits: an operation's output sample takes material and form from the input sample and its
// method from the operation, shown greyed and overridable; the code's date is the Create date and never changes. A free
// new sample has nothing to inherit. Pure, no Vue.

import { sampleCodeTemplate, type DraftBody, type DraftItem, type DraftKey, type DraftOperation } from '@d1/ui';
import { inputSampleOf, itemOf } from './draft';

export interface InheritCtx {
	/** The loaded fields of an existing item's record (an existing sample, an attached operation); undefined when not loaded. */
	record?: (item: DraftItem) => Record<string, unknown> | undefined;
	/** `alloy_code` of a material, for the code. */
	alloyCode?: (materialId: string) => string | null | undefined;
	/** The method's code ("MF"), for the code. */
	methodCode?: (methodId: string) => string | null | undefined;
	/** The Create date; today when left out. */
	today?: Date;
}

export type InheritedFrom = 'sample' | 'operation';

export interface Inherited {
	/** Only the fields the sample has no value of its own for. */
	values: Record<string, unknown>;
	from: Record<string, InheritedFrom>;
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

/** The fields of an item as they will be written or already are: the record, then the changes. */
const fieldsOf = (item: DraftItem, ctx: InheritCtx): Record<string, unknown> => ({ ...(ctx.record?.(item) ?? {}), ...item.values });

/** The operation row that makes a new sample (an output wire to a sample other than the one the row took in). */
export function makerOf(body: DraftBody, sampleKey: DraftKey): { op: DraftOperation; row: number } | null {
	for (const w of body.wires) {
		if (w.to.key !== sampleKey) continue;
		const op = itemOf(body, w.from.key);
		if (op?.kind !== 'operation') continue;
		const row = w.from.row ?? 0;
		if (inputSampleOf(body, { key: op.key, row }) !== sampleKey) return { op, row };
	}
	return null;
}

/** What a new sample inherits and does not set itself (nothing for an existing sample, or one no operation makes). */
export function inheritedValues(body: DraftBody, sampleKey: DraftKey, ctx: InheritCtx = {}): Inherited {
	const out: Inherited = { values: {}, from: {} };
	const sample = itemOf(body, sampleKey);
	if (sample?.kind !== 'sample' || sample.existing) return out;
	const maker = makerOf(body, sampleKey);
	if (!maker) return out;
	const mine = sample.values;
	const inKey = inputSampleOf(body, { key: maker.op.key, row: maker.row });
	const input = inKey ? itemOf(body, inKey) : undefined;
	if (input) {
		const theirs = fieldsOf(input, ctx);
		for (const f of ['material_id', 'form']) {
			if (empty(mine[f]) && !empty(theirs[f])) {
				out.values[f] = theirs[f];
				out.from[f] = 'sample';
			}
		}
	}
	const method = fieldsOf(maker.op, ctx).method_id;
	if (empty(mine.primary_method_id) && !empty(method)) {
		out.values.primary_method_id = method;
		out.from.primary_method_id = 'operation';
	}
	return out;
}

/** The sample's code template as it will be written: `{seq}-alloy-method-Y-M-D` with the Create date; '' while the alloy or method is unknown. */
export function sampleCodeFor(body: DraftBody, sampleKey: DraftKey, ctx: InheritCtx = {}): string {
	const sample = itemOf(body, sampleKey);
	if (sample?.kind !== 'sample' || sample.existing) return '';
	const all = { ...inheritedValues(body, sampleKey, ctx).values, ...sample.values };
	const material = all.material_id;
	const method = all.primary_method_id;
	return sampleCodeTemplate({
		alloyCode: typeof material === 'string' ? ctx.alloyCode?.(material) : null,
		methodCode: typeof method === 'string' ? ctx.methodCode?.(method) : null,
		date: ctx.today ?? new Date(),
	});
}

/**
 * The body with the code of every new sample composed (the code carries the Create date, so it is made when the draft is
 * created, never kept from earlier). A code someone set that is not a `{seq}` template is left alone. Same body when
 * nothing changes.
 */
export function withSampleCodes(body: DraftBody, ctx: InheritCtx = {}): DraftBody {
	let changed = false;
	const items = body.items.map((item) => {
		if (item.kind !== 'sample' || item.existing || item.remove) return item;
		const have = item.values.sample_code;
		if (typeof have === 'string' && have !== '' && !have.startsWith('{seq}')) return item;
		const code = sampleCodeFor(body, item.key, ctx);
		if (!code || code === have) return item;
		changed = true;
		return { ...item, values: { ...item.values, sample_code: code } };
	});
	return changed ? { ...body, items } : body;
}
