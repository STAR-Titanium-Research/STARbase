// Picking samples onto the canvas (spec E7): what the picker's confirm does on the draft, and the fly-in that goes with it. The picked
// samples are read (their cards and their versions), added to the draft as a column, and flown from their rows to their cards once
// the layout has put the cards in place; undo plays that backwards with ghosts of the cards, redo forwards again, and a person who
// asked for less motion gets a short fade instead.

import { computed, nextTick, ref, shallowRef, watch, type Ref } from 'vue';
import type { PickedRow } from '@d1/ui';
import type { useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { cardsOf, entryFor, planFly, playFly, rectOf, samplesLost, type FlyEntry, type FlyTarget, type Rect } from './flyIn';
import { sampleItemOf } from './socketRefs';
import type { EditMode } from './useEditMode';

type Canvas = ReturnType<typeof useMapCanvas>;
type ProcessMap = ReturnType<typeof useProcessMap>;

const prefersReducedMotion = (): boolean => {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
};

/** How far in from the top-left of the visible canvas the column of picked samples starts. */
export const COLUMN_INSET = 80;

export function useSamplePicking(o: { edit: EditMode; map: ProcessMap; canvas: Pick<Canvas, 'toFlow' | 'whenSettled'>; canvasEl: Ref<HTMLElement | null> }) {
	const { edit, map, canvas, canvasEl } = o;
	const open = ref(false);
	const problem = ref('');
	const log = shallowRef<FlyEntry[]>([]);
	/** Flies played, most recent last, for redo: the picks that were undone. */
	const undone = shallowRef<FlyEntry[]>([]);

	/** The record ids of the samples drawn on the canvas, which the picker will not let be ticked again. */
	const taken = computed(() => map.nodes.value.flatMap((n) => (n.type === 'record' && n.kind === 'sample' && !n.ref.id.startsWith('draft:') ? [n.ref.id] : [])));

	// ---- finding the cards on the screen -----------------------------------------------------------------
	function cardEl(id: string): HTMLElement | null {
		for (const el of canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? []) {
			if (el.dataset.id === `s:${id}`) return el.querySelector<HTMLElement>('.node') ?? el;
		}
		return null;
	}
	/** How far the canvas is zoomed: a card's size on the screen over its size in the viewport. 1 when it cannot be told. */
	function canvasZoom(): number {
		for (const node of canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? []) {
			const card = node.querySelector<HTMLElement>('.node') ?? node;
			if (!card.offsetWidth) continue;
			const z = card.getBoundingClientRect().width / card.offsetWidth;
			return Number.isFinite(z) && z > 0 ? z : 1;
		}
		return 1;
	}
	const landed = (ids: readonly string[]): Map<string, Rect | null> => new Map(ids.map((id) => [id, cardEl(id) ? rectOf(cardEl(id)!.getBoundingClientRect()) : null]));
	/** After the layout has put the cards where they go, and the browser has drawn them. */
	async function afterLayout(): Promise<void> {
		await nextTick();
		await canvas.whenSettled();
		await new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : r()));
	}

	const target: FlyTarget = {
		element: (id) => cardEl(id),
		ghost: (id, rect) => {
			const g = document.createElement('div');
			g.textContent = edit.catalog.samples.get(id)?.code ?? 'Sample';
			Object.assign(g.style, {
				position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '70', pointerEvents: 'none',
				boxSizing: 'border-box', padding: '10px 12px', borderRadius: '12px', border: '1.5px dashed var(--d1-accent, var(--theme--primary))',
				background: 'var(--d1-surface, var(--theme--background))', color: 'var(--theme--foreground)', fontWeight: '700', fontFamily: 'var(--theme--fonts--monospace--font-family, monospace)',
			});
			document.body.appendChild(g);
			return g;
		},
	};

	async function fly(entry: FlyEntry, reverse: boolean, from?: Map<string, Rect | null>): Promise<void> {
		const reduced = prefersReducedMotion();
		const places = from ?? landed(entry.ids);
		// The real cards fly inside the zoomed viewport; the ghosts of a reverse fly are fixed on the page, in screen pixels.
		const steps = planFly(cardsOf(entry.ids.map((id, i) => ({ id, rect: entry.rects[i] })), places), { reduced, reverse, zoom: reverse ? 1 : canvasZoom() });
		await playFly(steps, target, { reverse });
	}

	// ---- the picker's confirm ------------------------------------------------------------------------------
	async function picked(rows: PickedRow[]): Promise<void> {
		open.value = false;
		if (!rows.length || !edit.editing.value) return;
		let read;
		try {
			read = await edit.catalog.loadSamples(rows.map((r) => r.id));
		} catch {
			read = new Map();
		}
		const got = rows.filter((r) => read.has(r.id));
		if (got.length < rows.length) problem.value = got.length ? 'Some of the samples could not be read, so they were not added.' : 'The samples could not be read, so none was added.';
		if (!got.length) return;
		const r = canvasEl.value?.getBoundingClientRect();
		const at = r ? canvas.toFlow(r.left + COLUMN_INSET, r.top + COLUMN_INSET) : undefined;
		// One step: the samples and, when the draft has none yet, the project it takes from the first of them (E16).
		const project = read.get(got[0].id)?.sample.projectId;
		edit.apply([
			{ type: 'addExistingSamples', samples: got.map((g) => ({ id: g.id, version: read.get(g.id)!.version })), at },
			...(!edit.body.value.projectId && project ? [{ type: 'setProject' as const, projectId: project }] : []),
		]);
		const added = got.filter((g) => sampleItemOf(edit.body.value, g.id));
		if (!added.length) return;
		const entry: FlyEntry = { ids: added.map((g) => g.id), rects: added.map((g) => (g.rect ? rectOf(g.rect) : null)) };
		log.value = [...log.value, entry];
		undone.value = [];
		await afterLayout();
		await fly(entry, false);
	}

	// ---- undo and redo of a pick play it backwards and forwards ------------------------------------------
	/** Rects of the cards of every pick, taken before a change takes them away. */
	const rectsOfPicks = (): Map<string, Rect | null> => landed([...new Set([...log.value, ...undone.value].flatMap((e) => e.ids))]);

	function undo(): void {
		const before = edit.body.value;
		const rects = rectsOfPicks();
		edit.undo();
		const entry = entryFor(log.value, samplesLost(before, edit.body.value));
		if (!entry) return;
		log.value = log.value.filter((e) => e !== entry);
		undone.value = [...undone.value, entry];
		void fly(entry, true, rects);
	}
	function redo(): void {
		const before = edit.body.value;
		edit.redo();
		const entry = entryFor(undone.value, samplesLost(edit.body.value, before));
		if (!entry) return;
		undone.value = undone.value.filter((e) => e !== entry);
		log.value = [...log.value, entry];
		void afterLayout().then(() => fly(entry, false));
	}

	// A different draft, or none: the flies of the old one mean nothing.
	watch(
		() => edit.draft.draftId.value,
		() => {
			log.value = [];
			undone.value = [];
		},
	);

	return { open, problem, taken, picked, undo, redo };
}

export type SamplePicking = ReturnType<typeof useSamplePicking>;
