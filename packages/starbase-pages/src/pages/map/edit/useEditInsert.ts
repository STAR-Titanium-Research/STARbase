// "Insert before / after" the selected card and a drop on a wire (redesign R2, R3): the page's side of insertModel.ts. It reads what is selected,
// opens the add search for it (the operations that can go there), and does the verdict of the pure rules as ONE history step; a refusal is
// said where the person is looking (the lock reason of a done wire, or that a recorded sample can't be inserted before, among them).

import type { Ref } from 'vue';
import type { MapNode } from '../model/types';
import type { useProcessMap } from '../useProcessMap';
import type { DraftKey } from '@d1/ui';
import { apply, newKeys, type DraftAction } from './draft';
import { insertAround, insertBeforeRefusal, insertOnWire, insertRefusal, type InsertVerdict } from './insertModel';
import type { MenuChoice } from './menuModel';
import type { InsertTarget, MenuTarget } from './menuTarget';
import { sampleItemOf } from './socketRefs';
import type { EditMode } from './useEditMode';

type ProcessMap = ReturnType<typeof useProcessMap>;

export function useEditInsert(o: {
	edit: EditMode;
	map: ProcessMap;
	canvasEl: Ref<HTMLElement | null>;
	/** What adds a sample of the loaded history to the draft, not yet done (useEditCanvas): null when it could not be read. */
	sampleActions: (recordId: string) => Promise<DraftAction[] | null>;
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

	/** Samples and containers are asked about; a junction or a "+N more" is not (the key is the browser's). */
	const isCard = (n: MapNode | undefined): n is MapNode => !!n && ((n.type === 'record' && n.kind === 'sample') || n.type === 'container');
	/** The card's menu offers Insert only where something can be inserted: not on a struck-through card, a done or saved container, a recorded operation. */
	const canInsert = (n: MapNode | undefined): n is MapNode => isCard(n) && !insertRefusal(edit.body.value, n);
	/** Why "Insert before" is refused for the card (a recorded sample, R3), or null: the card's menu shows it disabled with this as its title. */
	const beforeRefusal = (n: MapNode | undefined): string | null => insertBeforeRefusal(n);

	/** Where the search opens for a card: just under its title, at its left. */
	function pointOf(node: MapNode): { x: number; y: number } {
		const el = [...(o.canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? [])].find((e) => e.dataset.id === node.id);
		const r = el?.getBoundingClientRect() ?? o.canvasEl.value?.getBoundingClientRect();
		return { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + Math.min(r?.height ?? 0, 60) };
	}

	/** Opens the insert search for the selected card. False (the key is the browser's) when nothing that can be inserted around is selected. */
	function openFor(where: 'before' | 'after', node: MapNode | undefined = selected()): boolean {
		if (!edit.editing.value || !isCard(node)) return false;
		// Refused up front, with the reason, not only after an operation is picked.
		const no = insertRefusal(edit.body.value, node);
		if (no) {
			o.say(no.reason);
			return true;
		}
		// A sample that is already a record is never given a maker from the map: no search, no draft change, no undo step.
		const noBefore = where === 'before' ? beforeRefusal(node) : null;
		if (noBefore) {
			o.say(noBefore);
			return true;
		}
		const insert: InsertTarget = { where, nodeId: node.id, what: o.nameOf(node) };
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

	/** A choice made in the insert search: the keys of the cards it added (the page shows the first), or false when it was refused or nothing was read. */
	async function choose(t: MenuTarget, choice: MenuChoice): Promise<DraftKey[] | false> {
		const ins = t.insert;
		const node = ins ? nodeById(ins.nodeId) : undefined;
		if (!ins || !node) return false;
		// A sample of the loaded history joins the draft (with the version it was read at) in the same step as the insert, but only if the insert
		// is not refused: the verdict is taken on a copy of the draft that already holds it, and nothing is applied before it.
		let adds: DraftAction[] = [];
		if (node.type === 'record' && !(ins.where === 'before' && beforeRefusal(node)) && !sampleItemOf(edit.body.value, node.ref.id)) {
			const read = await o.sampleActions(node.ref.id);
			if (!read) return false;
			adds = read;
		}
		const graph = map.graph.value;
		const fresh = nodeById(ins.nodeId) ?? node;
		if (!graph) return false;
		const body = adds.reduce((b, a) => apply(b, a), edit.body.value);
		const v = insertAround({ body, graph, node: fresh, where: ins.where, choice, at: t.flow });
		if (!v.ok) return applyVerdict(v, ins.nodeId, false) && [];
		// What the insert added, not the history sample that joined with it.
		return applyVerdict({ ok: true, actions: [...adds, ...v.actions] }, ins.nodeId, false) && newKeys(body, edit.body.value);
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

	return { openFor, choose, dropOnWire, wireVerdict, selected, canInsert, beforeRefusal };
}

export type EditInsert = ReturnType<typeof useEditInsert>;
