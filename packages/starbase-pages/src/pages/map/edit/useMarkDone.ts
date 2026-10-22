// Mark done from the rail (spec E6): a planned operation or test card, every row of it (or every pass of a stack) at once, with the
// date and who did it. It is an action, not a draft change, so it works in view mode and on phones too; it needs d1-build to be there.
// The server's refusal (the required fields of a done record) comes back as Checks and is shown in the dialog.

import { computed, ref, shallowRef } from 'vue';
import type { Check, HostApi } from '@d1/ui';
import { conformWindowChecks, readConformRuns, readPassCodes } from './conformChecks';
import type { ContainerNode } from '../model/types';
import type { useProcessMap } from '../useProcessMap';
import type { EditMode } from './useEditMode';

type ProcessMap = ReturnType<typeof useProcessMap>;

export interface MarkTarget {
	collection: 'manufacturing_operations' | 'test_sessions';
	ids: string[];
	title: string;
	/** The card is Conform runs: the dialog warns about a run with a log and no window (it can still be marked done). */
	conform?: true;
}

/** The card a Mark done applies to: a planned container of records, none of them still in a draft. Null for any other card. */
export function markTargetOf(node: { type: string } | undefined): MarkTarget | null {
	if (node?.type !== 'container') return null;
	const c = node as ContainerNode;
	if (!c.planned || c.draft || c.collapsed || !c.group.rowIds.length || c.group.rowIds.some((id) => id.startsWith('draft:'))) return null;
	const name = c.stacked || c.group.batch ? c.title : c.code || c.title;
	return { collection: c.kind === 'test' ? 'test_sessions' : 'manufacturing_operations', ids: [...c.group.rowIds], title: `Mark ${c.kind === 'test' ? 'test' : 'operation'} ${name} done`, ...(c.category === 'conform' ? { conform: true as const } : {}) };
}

export interface PlannedTarget {
	collection: 'manufacturing_operations' | 'test_sessions';
	ids: string[];
	title: string;
}

/**
 * The card a Back to planned applies to (E6): a done container of records, none still in a draft. The rail does not know who owns it,
 * so the button shows for every done container and the server (owner or admin only) refuses the rest, with the reason shown.
 */
export function plannedTargetOf(node: { type: string } | undefined): PlannedTarget | null {
	if (node?.type !== 'container') return null;
	const c = node as ContainerNode;
	if (c.planned || c.draft || c.collapsed || !c.group.rowIds.length || c.group.rowIds.some((id) => id.startsWith('draft:'))) return null;
	const name = c.stacked || c.group.batch ? c.title : c.code || c.title;
	return { collection: c.kind === 'test' ? 'test_sessions' : 'manufacturing_operations', ids: [...c.group.rowIds], title: `Set ${c.kind === 'test' ? 'test' : 'operation'} ${name} back to planned` };
}

export function useMarkDone(o: { edit: EditMode; map: ProcessMap; /** Reads a Conform run's window for the warning; without it the dialog has none. */ api?: Pick<HostApi, 'get'> }) {
	const { edit, map } = o;
	const open = ref(false);
	const busy = ref(false);
	const checks = ref<Check[]>([]);
	const error = ref('');

	/** The card the rail is on now. */
	const selectedTarget = computed(() => markTargetOf(map.graph.value?.nodes.find((n) => n.id === map.selectedId.value)));
	/** The card the dialog was opened for: what is selected may change while it is open (a click on another card), what is marked must not. */
	const opened = shallowRef<MarkTarget | null>(null);
	const target = computed(() => (open.value && opened.value ? opened.value : selectedTarget.value));
	/** The button shows for a planned card, when d1-build is there to do it. */
	const canMarkDone = computed(() => !!selectedTarget.value && edit.available.value);
	/** Back to planned shows for a done card (the server decides who may: its owner or an admin). */
	const selectedPlanned = computed(() => plannedTargetOf(map.graph.value?.nodes.find((n) => n.id === map.selectedId.value)));
	const canMarkPlanned = computed(() => !!selectedPlanned.value && edit.available.value);
	const settingBack = ref(false);

	/** Back to planned: at once, no dialog. A refusal (not the owner) is said in `error`, which the page shows. */
	async function markPlanned(): Promise<void> {
		const t = selectedPlanned.value;
		if (!t || !canMarkPlanned.value || settingBack.value) return;
		settingBack.value = true;
		error.value = '';
		try {
			const out = await edit.draft.markPlanned({ collection: t.collection, ids: t.ids });
			if (out.ok) map.reload();
			else error.value = out.message;
		} finally {
			settingBack.value = false;
		}
	}

	function show(): void {
		if (!canMarkDone.value) return;
		opened.value = selectedTarget.value;
		checks.value = [];
		error.value = '';
		open.value = true;
		void warnAboutWindows(opened.value);
	}
	/** A Conform run with a log and no window: a warning in the dialog (the server never refuses it). Dropped if the dialog moved on. */
	async function warnAboutWindows(t: MarkTarget | null): Promise<void> {
		if (!t?.conform || !o.api) return;
		const runs = await readConformRuns(o.api, t.ids);
		const lacking = conformWindowChecks(runs);
		if (!lacking.length) return;
		const found = conformWindowChecks(runs, await readPassCodes(o.api, lacking.map((c) => c.key)));
		if (found.length && open.value && opened.value === t && !busy.value && !checks.value.length) checks.value = found;
	}
	function cancel(): void {
		if (busy.value) return;
		open.value = false;
	}
	async function confirm(answer: { date: string; personId: string | null }): Promise<void> {
		const t = target.value;
		if (!t || busy.value) return;
		busy.value = true;
		checks.value = [];
		error.value = '';
		try {
			const out = await edit.draft.markDone({ collection: t.collection, ids: t.ids, date: answer.date, ...(answer.personId ? { personId: answer.personId } : {}) });
			if (out.ok) {
				open.value = false;
				// The records changed: the map is read again, so the card is solid and its samples active.
				map.reload();
			} else if (out.reason === 'checks') checks.value = out.checks;
			else {
				open.value = false;
				error.value = out.message;
			}
		} finally {
			busy.value = false;
		}
	}

	return { open, busy, checks, error, target, canMarkDone, show, cancel, confirm, canMarkPlanned, markPlanned, settingBack };
}
