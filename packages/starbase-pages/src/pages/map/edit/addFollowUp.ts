// What follows a click on the palette or a choice in the add search (process-map creator, K9-K11), without Vue or the DOM: a double click
// adds once, and an operation or a test chosen with no socket is wired to the sample just added, so the person does not have to drag.

import type { DraftBody, DraftKey } from '@d1/ui';
import { socketVerdict } from './addDrop';
import type { MenuChoice } from './menuModel';
import { draftId } from './toGraph';

/** A second click on the same entry this soon after the first is the same click (a double click, a bounce), not another card. */
export const REPEAT_ADD_MS = 500;

/** True when `id` was added by the last add less than `REPEAT_ADD_MS` ago. */
export function isRepeatAdd(last: { id: string; at: number } | null, id: string, now: number): boolean {
	return last?.id === id && now - last.at < REPEAT_ADD_MS;
}

/**
 * The new sample that an operation or a test added with no socket takes in, or null: the selected card when it is a new sample with no wire out,
 * else the last new sample of the draft with none. A sample of the history (`existing`) is never wired by a click: it has its own past, and
 * the person who wants it as an input drags or picks it. Null too when the draft would refuse the wire.
 */
export function autoWireSource(body: DraftBody, selectedKey: DraftKey | null, choice: MenuChoice): DraftKey | null {
	if (choice.kind !== 'operation' && choice.kind !== 'test') return null;
	const free = (key: DraftKey): boolean => !body.wires.some((w) => w.from.key === key);
	const fresh = body.items.filter((i) => i.kind === 'sample' && !i.existing && free(i.key));
	const picked = fresh.find((i) => i.key === selectedKey) ?? fresh[fresh.length - 1];
	if (!picked) return null;
	// The socket's id is the record id the sample card is drawn with (`draft:<key>`).
	return socketVerdict(body, { kind: 'sample', id: draftId(picked.key), side: 'out' }, choice).ok ? picked.key : null;
}
