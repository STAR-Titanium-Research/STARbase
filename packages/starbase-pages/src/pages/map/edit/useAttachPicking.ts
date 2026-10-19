// "From database…" (redesign R8, as scoped on 2026-10-19): the picker of recorded operations that have no input sample, and what choosing
// one does. It opens for a target (the socket the add search was on, or where the palette or a drop was: floating) and, on a pick, re-reads
// that operation AS IT IS NOW (its version is what Create checks the attach against), then hands `attachOperation` back to the add menu,
// whose `applyAt` brings the sample into the draft and attaches in the same undo step. Pure UI state: the rules are in attachModel.ts and
// draft.ts, the reads in useEditCatalog.ts.

import { computed, ref, shallowRef } from 'vue';
import type { MapNode, ProcessGraph } from '../model/types';
import { nodeOfSocket } from '../model/sockets';
import { orphanReason, type AttachSite, type OrphanRow } from './attachModel';
import type { MenuChoice } from './menuModel';
import type { MenuTarget } from './menuTarget';
import type { EditMode } from './useEditMode';

export const GONE = 'That operation is gone, or you can no longer see it.';
export const GOT_INPUT = 'It got an input in the meantime, so it cannot be attached any more.';
export const READ_FAILED = 'Could not read that operation. Try again.';

/** The record ids of the samples that lead into `start` on the drawn map (the start itself left out): what it was made from, as far as the map has loaded. */
export function ancestorSamples(graph: ProcessGraph | null | undefined, start: string): Set<string> {
	const out = new Set<string>();
	if (!graph) return out;
	const into = new Map<string, string[]>();
	for (const w of graph.wires) {
		const to = nodeOfSocket(w.to);
		into.set(to, [...(into.get(to) ?? []), nodeOfSocket(w.from)]);
	}
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const seen = new Set<string>([start]);
	const queue = [start];
	while (queue.length) {
		for (const from of into.get(queue.shift()!) ?? []) {
			if (seen.has(from)) continue;
			seen.add(from);
			queue.push(from);
			const node = byId.get(from);
			if (node?.type === 'record' && node.kind === 'sample') out.add(node.ref.id);
		}
	}
	return out;
}

export function useAttachPicking(o: {
	edit: EditMode;
	map: { graph: { value: ProcessGraph | null }; nodes: { value: MapNode[] } };
	/** What a choice at a target does (the add menu's `applyAt`). */
	applyAt: (t: MenuTarget, choice: MenuChoice) => Promise<void>;
}) {
	const { edit } = o;
	/** Where the picker is for: open while set. */
	const target = shallowRef<MenuTarget | null>(null);
	/** What went wrong with the last pick, said in the picker. */
	const problem = ref('');
	const busy = ref(false);

	function open(t: MenuTarget): void {
		if (!edit.editing.value) return;
		problem.value = '';
		target.value = t;
	}
	const close = (): void => void (target.value = null);

	/** The record ids of the operations drawn on the map: the loaded history and the draft's own. */
	const onCanvas = computed(() => new Set(o.map.nodes.value.flatMap((n) => (n.type === 'container' && n.kind === 'operation' ? n.group.rowIds.filter((id) => !id.startsWith('draft:')) : []))));

	/** The sample the operation would take in, as the map draws it. */
	const sampleNode = computed(() => {
		const sock = target.value?.sock;
		return sock?.kind === 'sample' ? o.map.graph.value?.nodes.find((n) => n.id === `s:${sock.id}`) : undefined;
	});
	/** What the picker knows about the place: greys what cannot go there. */
	const site = computed<AttachSite>(() => ({
		body: edit.body.value,
		onCanvas: onCanvas.value,
		samplePlanned: sampleNode.value?.type === 'record' && !!sampleNode.value.planned,
		ancestors: sampleNode.value ? ancestorSamples(o.map.graph.value, sampleNode.value.id) : new Set<string>(),
	}));
	const reasonOf = (row: OrphanRow): string | null => orphanReason(row, site.value);

	/** The operations with no input sample (the catalog reads them as the signed-in user). */
	const search = (query: string, offset = 0) => edit.catalog.searchOrphans(query, offset);

	/** A pick: read the operation as it is now, refuse here what cannot be attached, else attach it at the target. */
	async function pick(row: OrphanRow): Promise<void> {
		const t = target.value;
		if (!t || busy.value) return;
		problem.value = '';
		busy.value = true;
		try {
			let got;
			try {
				got = (await edit.catalog.loadOperations([row.id], { fresh: true })).get(row.id);
			} catch {
				problem.value = READ_FAILED;
				return;
			}
			if (!got) {
				problem.value = GONE;
				return;
			}
			if (got.hasInput) {
				problem.value = GOT_INPUT;
				return;
			}
			const workState = got.op.workState === 'planned' ? 'planned' : 'done';
			// What the reasons say, asked again of what was just read (it may have been marked done since the list was drawn).
			const why = reasonOf({ ...row, workState, version: got.version });
			if (why) {
				problem.value = why;
				return;
			}
			close();
			await o.applyAt(t, { kind: 'attachOperation', id: row.id, version: got.version, workState });
		} finally {
			busy.value = false;
		}
	}

	return { target, problem, busy, open, close, search, reasonOf, pick };
}

export type AttachPicking = ReturnType<typeof useAttachPicking>;
