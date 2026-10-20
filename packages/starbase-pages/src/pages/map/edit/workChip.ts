// The Planned / Done chip on a new operation or test (R9): what a drawn card offers, read from the draft. The card draws it and calls `toggle`;
// the rail's toggle makes the same change (EditMode.setWorkState), so either is one undoable step.

import type { DraftBody, DraftKey } from '@d1/ui';
import type { MapNode } from '../model/types';
import type { WorkState } from './draft';
import { draftKeysOfNode } from './socketRefs';
import { groupWorkState } from './workState';

export interface WorkChip {
	state: WorkState;
	/** What pressing it does, for the tooltip and the accessible name. */
	label: string;
	toggle(): void;
}

export function workChipOf(
	edit: { editing: { value: boolean }; body: { value: DraftBody }; setWorkState(keys: DraftKey[], state: WorkState): void },
	node: MapNode,
): WorkChip | null {
	if (!edit.editing.value) return null;
	const body = edit.body.value;
	const keys = draftKeysOfNode(body, node);
	const state = groupWorkState(keys.flatMap((k) => body.items.filter((i) => i.key === k)));
	if (!state) return null;
	const next: WorkState = state === 'done' ? 'planned' : 'done';
	return {
		state,
		label: state === 'done' ? 'Done: Create writes it as done. Press to make it planned.' : 'Planned: press to make it done at Create (asks for its date).',
		toggle: () => edit.setWorkState(keys, next),
	};
}
