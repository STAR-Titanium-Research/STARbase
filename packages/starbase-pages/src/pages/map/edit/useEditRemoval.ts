// Delete, X, Dissolve and wire removal on the canvas (redesign spec R4): the page's side of removal.ts. It reads what is selected (a card, or a
// wire the person clicked), asks the pure rules what that would do, says why not (and wears the lock) when nothing may go, and otherwise
// does it as ONE history step, so Undo and Redo cover it.
//
// A planned record that exists is not on the draft yet: it is read (its version), added, and marked `remove`, in the same step.

import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { MapNode } from '../model/types';
import type { useProcessMap } from '../useProcessMap';
import { recordKey } from './checks';
import { apply, type DraftAction } from './draft';
import { focusCanvas } from './focusCanvas';
import { dissolveVerdict, removeActions, removeVerdict, unwireActions, unwireEnd, unwireVerdict, type ExistingTarget, type RemovalCtx } from './removal';
import type { SocketRef } from './socketRefs';
import { resolveEnd } from './socketRefs';
import type { EditMode } from './useEditMode';

type ProcessMap = ReturnType<typeof useProcessMap>;

const COLLECTION = { operation: 'manufacturing_operations', test: 'test_sessions' } as const;

export function useEditRemoval(o: { edit: EditMode; map: ProcessMap; canvasEl: Ref<HTMLElement | null>; /** Where a reason is said (the banner under the lid). */ say: (text: string) => void }) {
	const { edit, map, canvasEl } = o;

	/** The wire the person clicked (a drawn wire's id): Delete takes it, until another card or wire is picked or the wire is gone. */
	const selectedWire = ref<string | null>(null);
	const selectWire = (id: string): void => void (selectedWire.value = selectedWire.value === id ? null : id);
	watch(() => map.selectedId.value, () => void (selectedWire.value = null));
	watch(
		() => map.graph.value,
		(g) => {
			if (selectedWire.value && !g?.wires.some((w) => w.id === selectedWire.value)) selectedWire.value = null;
		},
	);

	/** A click on the empty canvas (not a card, not a wire) lets go of the wire; so does Escape. */
	function onCanvasClick(e: MouseEvent): void {
		if (selectedWire.value && !(e.target as HTMLElement | null)?.closest?.('.vue-flow__edge, .vue-flow__node')) selectedWire.value = null;
	}
	const onEscape = (e: KeyboardEvent): void => {
		if (e.key === 'Escape' && selectedWire.value) selectedWire.value = null;
	};
	if (getCurrentInstance()) {
		onMounted(() => window.addEventListener('keydown', onEscape));
		onBeforeUnmount(() => window.removeEventListener('keydown', onEscape));
	}

	const ctx = (): RemovalCtx => ({ inHistory: (id) => !!map.data.value?.samples.some((s) => s.id === id) });
	const selectedNode = (): MapNode | undefined => {
		const id = map.selectedId.value;
		return id ? map.graph.value?.nodes.find((n) => n.id === id) : undefined;
	};

	// ---- what the cards show -----------------------------------------------------------------------
	/** Why a card cannot be removed (a done record), or null: the selected card wears a lock with this text. */
	function lockOf(node: MapNode): string | null {
		const graph = map.graph.value;
		if (!graph || !edit.editing.value) return null;
		const v = removeVerdict(edit.body.value, graph, node, ctx());
		return !v.ok && v.locked ? v.reason : null;
	}
	function wireLock(id: string): string | null {
		const graph = map.graph.value;
		if (!graph || !edit.editing.value) return null;
		const v = unwireVerdict(edit.body.value, graph, id);
		return !v.ok && v.locked ? v.reason : null;
	}

	const hasSelection = computed(() => edit.editing.value && (!!selectedWire.value || !!selectedNode()));
	/** The lid's Remove and Dissolve: on while something is selected (a refusal says why). */
	const canRemove = hasSelection;
	const canDissolve = computed(() => edit.editing.value && !selectedWire.value && selectedNode()?.type === 'container');

	// ---- doing it ------------------------------------------------------------------------------------
	/** The existing planned records a removal deletes, made items of the draft (their version read first). Null: one could not be read. */
	async function addExisting(targets: ExistingTarget[]): Promise<DraftAction[] | null> {
		const out: DraftAction[] = [];
		for (const t of targets) {
			if (edit.body.value.items.some((i) => i.kind === t.kind && i.existing?.id === t.id)) continue;
			if (t.kind === 'sample') {
				const read = (await edit.catalog.loadSamples([t.id]).catch(() => new Map())).get(t.id);
				if (!read) return null;
				out.push({ type: 'addExistingSamples', samples: [{ id: t.id, version: read.version }] });
			} else {
				const collection = COLLECTION[t.kind];
				await edit.catalog.loadRecords({ physical_samples: [], manufacturing_operations: [], test_sessions: [], [collection]: [t.id] });
				const version = edit.catalog.records.get(recordKey(collection, t.id))?.version;
				if (version === undefined) return null;
				out.push({ type: 'addExisting', kind: t.kind, record: { id: t.id, version }, workState: 'planned' });
			}
		}
		return out;
	}

	const settle = (): void => void nextTick().then(() => focusCanvas(canvasEl.value));

	async function removeNode(node: MapNode): Promise<void> {
		const graph = map.graph.value;
		if (!graph) return;
		const v = removeVerdict(edit.body.value, graph, node, ctx());
		if (!v.ok) return o.say(v.reason);
		// Nothing to read first (a card of the draft): done in this tick, so a key press is one step at once.
		if (!v.existing.length) {
			const now = removeActions(edit.body.value, v);
			if (now.length) edit.apply(now);
			return settle();
		}
		const adds = await addExisting(v.existing);
		if (!adds) return o.say('That record could not be read, so it cannot be deleted yet. Try again in a moment.');
		const pre: DraftBody = adds.reduce((b, a) => apply(b, a), edit.body.value);
		const actions = [...adds, ...removeActions(pre, v)];
		if (!actions.length) return;
		edit.apply(actions);
		settle();
	}

	function removeWire(id: string): void {
		const graph = map.graph.value;
		if (!graph) return;
		const v = unwireVerdict(edit.body.value, graph, id);
		if (!v.ok) return o.say(v.reason);
		edit.apply(unwireActions(v));
		selectedWire.value = null;
		settle();
	}

	/** Delete, Backspace, X: the selected wire, else the selected card. False (the key is the browser's) when nothing is selected. */
	function removeSelected(): boolean {
		if (!edit.editing.value) return false;
		if (selectedWire.value) {
			removeWire(selectedWire.value);
			return true;
		}
		const node = selectedNode();
		if (!node) return false;
		void removeNode(node);
		return true;
	}

	/** Ctrl/⌘+Delete: the selected container goes and its input is wired to its output. */
	function dissolveSelected(): boolean {
		if (!edit.editing.value || selectedWire.value) return false;
		const node = selectedNode();
		const graph = map.graph.value;
		if (!node || !graph) return false;
		const v = dissolveVerdict(edit.body.value, graph, node);
		if (!v.ok) {
			o.say(v.reason);
			return true;
		}
		edit.apply(v.actions);
		settle();
		return true;
	}

	/**
	 * A wire's end dragged off its socket and dropped on empty canvas: the draft's wire into that socket goes. True when there was one
	 * (the socket's own wire: only an input has exactly one).
	 */
	function dropWireAt(sock: SocketRef): boolean {
		if (!edit.editing.value || sock.side !== 'in') return false;
		const end = resolveEnd(edit.body.value, sock);
		if (!end) return false;
		const v = unwireEnd(edit.body.value, end);
		if (!v.ok) return false;
		edit.apply(unwireActions(v));
		return true;
	}

	return { selectedWire, selectWire, lockOf, wireLock, canRemove, canDissolve, removeSelected, dissolveSelected, dropWireAt, onCanvasClick, onEscape };
}

export type EditRemoval = ReturnType<typeof useEditRemoval>;
