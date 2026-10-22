// What a new draft card asks for on the card itself (spec K4, K5, K6, K8), apart from Vue (pure, tested): which fields it draws, which of
// them are read-only there, and which are flagged amber because the draft's checks say they are missing.

import type { Check, DraftBody, DraftItem, DraftKey } from '@d1/ui';
import { MAX_SETTINGS } from '../model/formSlots';
import type { MapNode } from '../model/types';
import { checksFor, SERVER_ONLY_CODES } from './checks';
import { itemOf } from './draft';
import { keySettingsFor } from './draftForm';
import { makerOf } from './inherit';
import { keyFieldsFor } from './railForm';
import { draftKeysOfNode } from './socketRefs';

/** The kind is chosen with the dropdown under the card's header (K3), so the card's fields never ask for it. */
const THE_KIND = new Set(['method_id', 'test_type']);

/** A new sample's name: the column its card shows as the name under the code (`ref.label`, set from `nickname` in model/buildGraph). */
export const SAMPLE_NAME_FIELD = 'nickname';

/**
 * The fields typed on a new card, in the order the form draws them. A sample: its name, material, geometry and the method of its code
 * (K6). An operation or a test: what the rail's compact form asks for (the machine, the planned date or, once done, the date and what
 * the forms require, then the key settings of its kind) without the kind itself, and with at most four key settings, none twice (K4).
 */
export function cardFieldsFor(item: DraftItem, _body: DraftBody, ctx: { requiredForDone?: string[] } = {}): string[] {
	if (item.kind === 'sample') return [SAMPLE_NAME_FIELD, 'material_id', 'form', 'primary_method_id'];
	const own = item.kind === 'test' ? item.values.test_type : item.values.process_category;
	const settings = keySettingsFor(item.kind, typeof own === 'string' ? own : undefined);
	const kept = new Set(settings.filter((f) => !THE_KIND.has(f)).slice(0, MAX_SETTINGS));
	// What the forms require of a done card is never capped away, even if it is a key setting past the fourth.
	const dropped = new Set(settings.filter((f) => !kept.has(f) && !ctx.requiredForDone?.includes(f)));
	const fields = keyFieldsFor(item, undefined, ctx.requiredForDone ?? []).filter((f) => !THE_KIND.has(f) && !dropped.has(f));
	return [...new Set(fields)];
}

/** The fields of the card's checks that the person can fill in: what only the server can tell (a record gone, a permission) names no field of the card. */
export function flaggedFields(checks: Check[], key: DraftKey): string[] {
	const fields = checksFor(checks, key)
		.filter((c) => !(c.code && SERVER_ONLY_CODES.has(c.code)))
		.flatMap((c) => (c.field ? [c.field] : []));
	return [...new Set(fields)];
}

/** "Made by" on a sample something in the draft makes is the operation's kind, shown and not typed (§5a): it stays read-only there. */
export function readonlyOnCard(item: DraftItem, body: DraftBody): string[] {
	return item.kind === 'sample' && makerOf(body, item.key) ? ['primary_method_id'] : [];
}

/** The relation fields a card draws as slot rows (K4): the kind of record they hold, which gives the row its icon and colour as in the Inside tray. */
export const SLOT_KIND: Readonly<Record<string, 'equipment' | 'tool' | 'insert_edge' | 'recipe'>> = {
	equipment_id: 'equipment',
	tool_id: 'tool',
	insert_edge_id: 'insert_edge',
	fast_recipe_id: 'recipe',
	source_recipe_id: 'recipe',
};

export interface CardSegment {
	/** Set for a slot row (one relation field); a run of plain fields has none. */
	slot?: (typeof SLOT_KIND)[string];
	fields: string[];
}

/** The card's fields in order, cut into runs of plain fields and one slot row for each relation, so each draws as it should. */
export function cardSegments(fields: readonly string[]): CardSegment[] {
	const out: CardSegment[] = [];
	for (const f of fields) {
		const slot = SLOT_KIND[f];
		const last = out[out.length - 1];
		if (slot) out.push({ slot, fields: [f] });
		else if (last && !last.slot) last.fields.push(f);
		else out.push({ fields: [f] });
	}
	return out;
}

/**
 * The draft item whose fields a card draws, or null: a new sample, or a new operation or test whose kind is chosen (before that the card
 * is its header and the kind dropdown, K3). A card made of several items (a stack of passes) or of a record that exists draws none.
 */
export function cardItemOf(body: DraftBody, node: MapNode): DraftItem | null {
	const keys = draftKeysOfNode(body, node);
	const item = keys.length === 1 ? itemOf(body, keys[0]) : undefined;
	if (!item || item.existing || item.remove) return null;
	if (item.kind === 'sample') return item;
	const chosen = item.values[item.kind === 'test' ? 'test_type' : 'method_id'];
	return typeof chosen === 'string' && chosen !== '' ? item : null;
}
