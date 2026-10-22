// What choosing another kind does to a new operation or test (spec K3): the kind itself (method and its process category, or the test type),
// and the settings of the old kind that the new one has no place for, taken away. Pure, no Vue: EditMode.setKind applies it as one undo step.

import type { DraftOperation, DraftTest } from '@d1/ui';
import type { ProcessCategory } from '../model/types';

/** A chosen kind: an operation's method with its process category, or a test's type. */
export type KindChoice = { methodId: string; category: ProcessCategory } | { testType: string };

const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * The patch for `setValues` that makes `item` the kind `next`, and the fields it drops: a key setting of the old kind (`keyFields`, as the
 * form draws them) that the new kind does not have and that has a value is set to `undefined`. Fields both kinds have are kept (the same
 * category, or a setting both lists name), so Turning to Milling drops nothing and Turning to FAST drops the machining settings. A choice
 * of the other kind of item (a test type for an operation) changes nothing.
 */
export function kindChange(
	item: DraftOperation | DraftTest,
	next: KindChoice,
	keyFields: (item: DraftOperation | DraftTest) => string[],
): { patch: Record<string, unknown>; dropped: string[] } {
	const forTest = 'testType' in next;
	if ((item.kind === 'test') !== forTest) return { patch: {}, dropped: [] };
	const patch: Record<string, unknown> = forTest ? { test_type: next.testType } : { method_id: next.methodId, process_category: next.category ?? undefined };
	const after = { ...item, values: { ...item.values, ...patch } };
	const kept = new Set(keyFields(after));
	const dropped = keyFields(item).filter((f) => !kept.has(f) && hasValue(item.values[f]));
	for (const f of dropped) patch[f] = undefined;
	return { patch, dropped };
}

/** A test type's choice text, "Destructive — Tensile", as its group and its own name; a text with no group is in Other. */
export function splitTestType(text: string): { group: string; name: string } {
	const at = text.indexOf(' — ');
	return at > 0 ? { group: text.slice(0, at), name: text.slice(at + 3) } : { group: 'Other', name: text };
}

/** The method id of an operation, or the test type of a test, once chosen; null while it is not. */
export function chosenKind(item: DraftOperation | DraftTest): string | null {
	const chosen = item.values[item.kind === 'test' ? 'test_type' : 'method_id'];
	return typeof chosen === 'string' && chosen !== '' ? chosen : null;
}
