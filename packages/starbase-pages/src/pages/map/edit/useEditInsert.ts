// "Insert before / after" the selected card, a drop on a wire, and "Add an earlier step" (redesign R2, R3): the page's side of insertModel.ts. It reads
// what is selected, opens the add search for it (the operations that can go there, or the one step a done sample may take), and does the
// verdict of the pure rules as ONE history step; a refusal is said where the person is looking (the lock reason of a done wire among them).

import type { Ref } from 'vue';
import type { MapNode } from '../model/types';
import type { useProcessMap } from '../useProcessMap';
import { insertAround, insertOnWire, type InsertVerdict } from './insertModel';
import type { MenuChoice } from './menuModel';
import type { InsertTarget, MenuTarget } from './menuTarget';
import { sampleItemOf } from './socketRefs';
import type { EditMode } from './useEditMode';

type ProcessMap = ReturnType<typeof useProcessMap>;

export function useEditInsert(o: {
	edit: EditMode;
	map: ProcessMap;
	canvasEl: Ref<HTMLElement | null>;
	ensureSample: (recordId: string, opts?: { merge?: boolean }) => Promise<boolean>;
	/** Opens the add search for an insert. */
	open: (t: MenuTarget) => void;
	/** What a card is called in a title ("S-0412-A"). */
	nameOf: (node: MapNode) => string;
	/** Says why nothing was done: at a point of the canvas when there is one (a drop), else where the canvas says its own problems. */
	say: (text: string, at?: { x: number; y: number }) => void;
}) {
	const { edit, map } = o;
	const nodeById = (id: string): MapNode | undefined => map.graph.value?.nodes.find((n) => n.id === id);
	const selected = (): MapNode | undefined => {
		const id = map.selectedId.value;
		return id ? nodeById(id) : undefined;
	};

	/** Samples and containers can be inserted around; a junction or a "+N more" cannot. */
	const canInsert = (n: MapNode | undefined): n is MapNode => !!n && ((n.type === 'record' && n.kind === 'sample') || n.type === 'container');
	/** A done sample is never given a parent: "before" it is the earlier step (R3). */
	const isDoneSample = (n: MapNode | undefined): boolean => !!n && n.type === 'record' && n.kind === 'sample' && !n.draft && !n.planned;

	/** Where the search opens for a card: just under its title, at its left. */
	function pointOf(node: MapNode): { x: number; y: number } {
		const el = [...(o.canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? [])].find((e) => e.dataset.id === node.id);
		const r = el?.getBoundingClientRect() ?? o.canvasEl.value?.getBoundingClientRect();
		return { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + Math.min(r?.height ?? 0, 60) };
	}

	/** Opens the insert search for the selected card. False (the key is the browser's) when nothing that can be inserted around is selected. */
	function openFor(where: 'before' | 'after', node: MapNode | undefined = selected()): boolean {
		if (!edit.editing.value || !canInsert(node)) return false;
		const insert: InsertTarget = { where, nodeId: node.id, what: o.nameOf(node), ...(where === 'before' && isDoneSample(node) ? { earlier: true as const } : {}) };
		o.open({ sock: null, at: pointOf(node), anchor: node.id, insert });
		return true;
	}

	function applyVerdict(v: InsertVerdict, anchor: string | undefined, merge: boolean, at?: { x: number; y: number }): boolean {
		if (!v.ok) {
			o.say(v.reason, at);
			return false;
		}
		edit.apply(v.actions, { anchor, merge });
		return true;
	}

	/** A choice made in the insert search. */
	async function choose(t: MenuTarget, choice: MenuChoice): Promise<void> {
		const ins = t.insert;
		const node = ins ? nodeById(ins.nodeId) : undefined;
		if (!ins || !node) return;
		// A sample of the loaded history joins the draft first (with the version it was read at): the two are one undo step.
		let folded = false;
		if (node.type === 'record' && choice.kind !== 'earlierStep' && !sampleItemOf(edit.body.value, node.ref.id)) {
			if (!(await o.ensureSample(node.ref.id))) return;
			folded = true;
		}
		const graph = map.graph.value;
		const fresh = nodeById(ins.nodeId) ?? node;
		if (!graph) return;
		applyVerdict(insertAround({ body: edit.body.value, graph, node: fresh, where: ins.where, choice, at: t.flow }), ins.nodeId, folded);
	}

	/** An entry dropped on the drawn wire `wireId`: put between its two ends, as one step; refused with the reason (a done wire's lock among them). */
	function dropOnWire(wireId: string, choice: MenuChoice, flow: { x: number; y: number } | undefined, at: { x: number; y: number }): boolean {
		const graph = map.graph.value;
		if (!graph || !edit.editing.value) return false;
		return applyVerdict(insertOnWire(edit.body.value, graph, wireId, choice, flow), undefined, false, at);
	}

	/** What a drop on a wire would do, without doing it: the refusal (with whether it is a lock), or null when it fits. */
	function wireVerdict(wireId: string, choice: MenuChoice): { reason: string; locked: boolean } | null {
		const graph = map.graph.value;
		if (!graph) return { reason: 'There is no map to drop on.', locked: false };
		const v = insertOnWire(edit.body.value, graph, wireId, choice);
		return v.ok ? null : { reason: v.reason, locked: v.locked };
	}

	return { openFor, choose, dropOnWire, wireVerdict, selected, canInsert, isDoneSample };
}

export type EditInsert = ReturnType<typeof useEditInsert>;
