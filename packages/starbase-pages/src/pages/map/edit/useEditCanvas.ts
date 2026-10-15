// Edit mode on the canvas (spec E8, E9, §7.2): what a click or a drag on a socket does, the red badges, ＋ output, and where the draft keeps
// its cards. The node components only draw buttons and report pointer events (nodes/actions.ts, MapEdit); this decides.
//
// A click on a socket (a pointer that did not move) opens the Add menu there. A drag draws a wire preview that follows the pointer
// and marks the socket it is over green when the draft takes the wire and red when it does not (with the reducer's reason as a
// tooltip); dropped on a socket that fits it makes the wire, dropped on empty canvas it opens the Add menu at that point, and
// anywhere else it does nothing. No gesture needs dragging: Enter on a focused socket opens its menu too (E21).

import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import type { DraftKey } from '@d1/ui';
import type { MapEdit } from '../nodes/actions';
import type { MapNode } from '../model/types';
import type { CanvasEdit, useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { blocking } from './checks';
import type { MenuTarget } from './menuTarget';
import { decodeSocket, draftKeysOfNode, encodeSocket, nearestSocket, newOperationOf, sampleItemOf, type SocketRef, type SocketSpot } from './socketRefs';
import type { EditMode } from './useEditMode';
import { dropVerdict, wireOf, type DropVerdict } from './wireDrop';

type ProcessMap = ReturnType<typeof useProcessMap>;
type Canvas = ReturnType<typeof useMapCanvas>;

/** A pointer that moves less than this many pixels between going down and up on a socket is a click. */
export const CLICK_SLOP = 4;

/** What the canvas asks of the draft: where its cards are, and being told when one is moved or the layout was redone. */
export function canvasEditOf(edit: EditMode): CanvasEdit {
	const keyOf = (n: MapNode): DraftKey | undefined => draftKeysOfNode(edit.body.value, n)[0];
	return {
		positionOf: (n) => (edit.editing.value ? (edit.body.value.positions[keyOf(n) ?? ''] ?? undefined) : undefined),
		moved: (n, at) => {
			const key = keyOf(n);
			if (key) edit.apply({ type: 'move', key, x: at.x, y: at.y });
		},
		relaid: (cards) => {
			const moves = cards.flatMap(({ node, at }) => {
				const key = keyOf(node);
				return key ? [{ type: 'move' as const, key, x: at.x, y: at.y }] : [];
			});
			if (moves.length) edit.apply(moves);
		},
	};
}

export interface WirePreview {
	/** Where it starts and where the pointer is, relative to the canvas element. */
	from: { x: number; y: number };
	to: { x: number; y: number };
	/** The socket under the pointer says yes (true), no (false), or there is none (null). */
	ok: boolean | null;
	/** Why the draft refuses it, when it does. */
	reason: string | null;
}

export function useEditCanvas(o: { edit: EditMode; map: ProcessMap; canvas: Canvas; canvasEl: Ref<HTMLElement | null>; openMenu: (t: MenuTarget) => void }) {
	const { edit, map, canvas, canvasEl } = o;

	const drop = ref<{ sock: string; ok: boolean } | null>(null);
	const preview = shallowRef<WirePreview | null>(null);
	/** A refused drop's reason, kept a moment where the wire was dropped. */
	const refusal = shallowRef<{ text: string; x: number; y: number } | null>(null);
	let refusalTimer: ReturnType<typeof setTimeout> | null = null;
	/** Said under the lid when something could not be done (a sample that could not be read). */
	const problem = ref('');

	function say(text: string, at: { x: number; y: number }): void {
		refusal.value = { text, ...at };
		if (refusalTimer) clearTimeout(refusalTimer);
		refusalTimer = setTimeout(() => void (refusal.value = null), 3500);
	}

	// ---- cards of the draft ---------------------------------------------------------------------------
	const nodeById = (id: string | undefined): MapNode | undefined => (id ? map.graph.value?.nodes.find((n) => n.id === id) : undefined);

	/** A sample of the loaded history becomes an item of the draft (with the version it was read at), so a wire can start from it. */
	async function ensureSample(recordId: string): Promise<boolean> {
		if (sampleItemOf(edit.body.value, recordId)) return true;
		let read;
		try {
			read = (await edit.catalog.loadSamples([recordId])).get(recordId);
		} catch {
			read = undefined;
		}
		if (!read) {
			problem.value = 'That sample could not be read, so it cannot be built from.';
			return false;
		}
		// One step: the sample and, when the draft has none yet, the project it takes from it (E16).
		edit.apply([
			{ type: 'addExistingSamples', samples: [{ id: recordId, version: read.version }] },
			...(!edit.body.value.projectId && read.sample.projectId ? [{ type: 'setProject' as const, projectId: read.sample.projectId }] : []),
		]);
		return !!sampleItemOf(edit.body.value, recordId);
	}

	/** Makes the wire a verdict stands for: adds the samples it needs to the draft first. */
	async function connect(v: DropVerdict, anchor?: string): Promise<boolean> {
		for (const s of [v.from, v.to]) if (s?.kind === 'sample' && !(await ensureSample(s.id))) return false;
		const wire = wireOf(edit.body.value, v);
		if (!wire) return false;
		const before = edit.body.value;
		edit.apply({ type: 'wire', ...wire }, { anchor });
		return edit.body.value !== before;
	}

	// ---- sockets under the pointer ------------------------------------------------------------------------
	function spotsOf(): SocketSpot[] {
		const out: SocketSpot[] = [];
		for (const el of canvasEl.value?.querySelectorAll<HTMLElement>('[data-sock]') ?? []) {
			const sock = decodeSocket(el.dataset.sock);
			if (!sock) continue;
			const r = el.getBoundingClientRect();
			out.push({ sock, x: r.left + r.width / 2, y: r.top + r.height / 2 });
		}
		return out;
	}
	/** Anywhere on the empty canvas: not on a card, a control or the minimap. */
	function onEmptyCanvas(x: number, y: number): boolean {
		const el = document.elementFromPoint(x, y);
		return !!el && !!canvasEl.value?.contains(el) && !el.closest('.vue-flow__node, .vue-flow__controls, .vue-flow__minimap, .vue-flow__edge, .pm-wirepreview');
	}
	const relative = (x: number, y: number) => {
		const r = canvasEl.value?.getBoundingClientRect();
		return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
	};

	// ---- a pointer on a socket ---------------------------------------------------------------------------------
	let stop: (() => void) | null = null;
	function socketDown(sock: SocketRef, e: PointerEvent): void {
		if (!edit.editing.value || (e.pointerType === 'mouse' && e.button !== 0) || stop) return;
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		const anchor = (el.closest('.vue-flow__node') as HTMLElement | null)?.dataset.id;
		const spots = spotsOf().filter((s) => !(s.sock.kind === sock.kind && s.sock.id === sock.id && s.sock.side === sock.side));
		const down = { x: e.clientX, y: e.clientY };
		let moved = false;
		let verdict: DropVerdict | null = null;
		const before = document.body.style.userSelect;

		const onMove = (ev: PointerEvent) => {
			if (!moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < CLICK_SLOP) return;
			if (!moved) {
				moved = true;
				document.body.style.userSelect = 'none';
				map.clearHover();
			}
			const spot = nearestSocket(spots, ev.clientX, ev.clientY);
			verdict = spot ? dropVerdict(edit.body.value, sock, spot.sock) : null;
			drop.value = spot && verdict ? { sock: encodeSocket(spot.sock), ok: verdict.ok } : null;
			preview.value = { from: relative(start.x, start.y), to: relative(ev.clientX, ev.clientY), ok: verdict ? verdict.ok : null, reason: verdict && !verdict.ok ? (verdict.reason ?? null) : null };
		};
		const finish = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onCancel);
			window.removeEventListener('keydown', onKey, true);
			document.body.style.userSelect = before;
			drop.value = null;
			preview.value = null;
			stop = null;
		};
		const onUp = (ev: PointerEvent) => {
			const v = verdict;
			finish();
			if (!moved) {
				o.openMenu({ sock, at: { x: start.x, y: start.y }, anchor });
				return;
			}
			if (v?.ok) void connect(v, anchor);
			else if (v) say(v.reason ?? 'That does not fit.', relative(ev.clientX, ev.clientY));
			else if (onEmptyCanvas(ev.clientX, ev.clientY)) o.openMenu({ sock, at: { x: ev.clientX, y: ev.clientY }, flow: canvas.toFlow(ev.clientX, ev.clientY), anchor });
		};
		const onCancel = () => finish();
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.stopPropagation();
			finish();
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onCancel);
		window.addEventListener('keydown', onKey, true);
		stop = finish;
	}

	/** Enter on a focused socket opens its menu, as a click does (E21). */
	function socketKey(sock: SocketRef, e: KeyboardEvent): void {
		if (e.key !== 'Enter' || !edit.editing.value) return;
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		o.openMenu({ sock, at: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, anchor: (el.closest('.vue-flow__node') as HTMLElement | null)?.dataset.id });
	}

	// ---- badges and ＋ output ---------------------------------------------------------------------------------------
	const blockers = computed(() => blocking(edit.checks.value));
	function badge(node: MapNode): { count: number; text: string } | null {
		const keys = draftKeysOfNode(edit.body.value, node);
		if (!keys.length) return null;
		const mine = blockers.value.filter((c) => keys.includes(c.key));
		return mine.length ? { count: mine.length, text: mine.map((c) => c.text).join(' ') } : null;
	}
	const canAddRow = (node: MapNode): boolean => node.type === 'container' && node.kind === 'operation' && !node.stacked && !!newOperationOf(edit.body.value, draftKeysOfNode(edit.body.value, node)[0] ?? null);
	function addRow(nodeId: string): void {
		const node = nodeById(nodeId);
		const key = node ? draftKeysOfNode(edit.body.value, node)[0] : undefined;
		if (!key || !canAddRow(node!)) return;
		// The card grows: the layout that follows measures it again and pushes the cards it now lies on (placeMerged).
		edit.apply({ type: 'addOutputRow', key }, { anchor: nodeId });
	}

	const mapEdit: MapEdit = { editing: edit.editing, drop, socketDown, socketKey, badge, addRow, canAddRow };

	if (getCurrentInstance()) {
		onBeforeUnmount(() => {
			stop?.();
			if (refusalTimer) clearTimeout(refusalTimer);
		});
	}

	return { mapEdit, preview, refusal, problem, ensureSample, connect, nodeById };
}
