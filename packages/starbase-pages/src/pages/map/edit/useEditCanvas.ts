// Edit mode on the canvas (spec E8, E9, §7.2): what a click or a drag on a socket does, the red badges, ＋ output, and where the draft keeps
// its cards. The node components only draw buttons and report pointer events (nodes/actions.ts, MapEdit); this decides.
//
// Sockets are derived (R5): a card draws a socket for each wire it has and one free one on each side while it is selected (or has nothing
// wired on that side). Nothing about them is in the draft. A wire connected to the free socket of an operation that has a wire on every
// row adds the row it stands for, in the same step (`connectActions`).
//
// A click on a socket (a pointer that did not move) opens the Add menu there. A drag draws a wire preview that follows the pointer
// and marks the socket it is over green when the draft takes the wire and red when it does not (with the reducer's reason as a
// tooltip); dropped on a socket that fits it makes the wire, dropped on empty canvas it opens the Add menu at that point, and
// anywhere else it does nothing. (A wire's end dragged off an input that has one and dropped on empty canvas takes the wire off.) No gesture needs dragging: Enter on a focused socket opens its menu too, and C its "Connect to…" (E21).

import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import type { DraftKey } from '@d1/ui';
import type { MapEdit } from '../nodes/actions';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode } from '../model/types';
import type { CanvasEdit, useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { blocking, warnings } from './checks';
import type { MenuTarget } from './menuTarget';
import { decodeSocket, draftKeyOfNode, draftKeysOfNode, encodeSocket, nearestSocket, sampleItemOf, type SocketRef, type SocketSpot } from './socketRefs';
import type { EditMode } from './useEditMode';
import { connectActions, dropVerdict, type DropVerdict } from './wireDrop';

type ProcessMap = ReturnType<typeof useProcessMap>;
type Canvas = ReturnType<typeof useMapCanvas>;

/** A pointer that moves less than this many pixels between going down and up on a socket is a click. */
export const CLICK_SLOP = 4;

/** What the canvas asks of the draft: where its cards are, and being told when one is moved or the layout was redone. */
export function canvasEditOf(edit: EditMode, inHistory: (sampleId: string) => boolean = () => false): CanvasEdit {
	const keyOf = (n: MapNode): DraftKey | undefined => draftKeysOfNode(edit.body.value, n)[0];
	return {
		active: () => edit.drafted.value,
		positionOf: (n) => (edit.editing.value ? (edit.body.value.positions[keyOf(n) ?? ''] ?? undefined) : undefined),
		moved: (n, at, from) => {
			const key = keyOf(n);
			if (!key) return;
			// A card the draft kept no place for: where it was taken from is kept in the step before, so Undo of this drag can bring it back.
			if (from && !edit.body.value.positions[key]) edit.apply({ type: 'move', key, x: from.x, y: from.y }, { merge: true });
			edit.apply({ type: 'move', key, x: at.x, y: at.y });
		},
		owned: (n) => !!n.type && (('draft' in n && !!n.draft) || (n.type === 'record' && n.kind === 'sample' && !inHistory(n.ref.id) && edit.catalog.samples.has(n.ref.id) && draftKeyOfNode(edit.body.value, n) !== null)),
		settled: (cards) => {
			const moves = cards.flatMap(({ node, at }) => {
				const key = keyOf(node);
				return key ? [{ type: 'move' as const, key, x: at.x, y: at.y }] : [];
			});
			// A layout's write is nobody's step: it joins the step that added the card, and Redo is left as it was.
			if (moves.length) edit.apply(moves, { merge: true, keepFuture: true });
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

/** What the card components read from edit mode that useEditRemoval adds (wire selection, locks): the surface joins the two. */
export type MapEditRemoval = 'selectedWire' | 'selectWire' | 'lockOf' | 'wireLock';

export function useEditCanvas(o: {
	edit: EditMode;
	map: ProcessMap;
	canvas: Canvas;
	canvasEl: Ref<HTMLElement | null>;
	openMenu: (t: MenuTarget) => void;
	openConnect?: (t: MenuTarget) => void;
	/**
	 * A wire end dragged off a WIRED socket and dropped on empty canvas: takes the wire (true) instead of opening the menu. `socketId` is the id
	 * of the socket grabbed (the Handle's), which is how the wire is told from the others. Never asked for a free socket.
	 */
	dropWire?: (sock: SocketRef, socketId: string) => boolean;
}) {
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

	/**
	 * A sample of the loaded history becomes an item of the draft (with the version it was read at), so a wire can start from it.
	 * `merge`: it joins the step before it in the undo history (a second sample, or the wire that needed it) instead of being its own.
	 */
	async function ensureSample(recordId: string, opts: { merge?: boolean } = {}): Promise<boolean> {
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
		], { merge: opts.merge });
		return !!sampleItemOf(edit.body.value, recordId);
	}

	/** Makes the wire a verdict stands for: adds the samples it needs to the draft first; the samples and the wire are one undo step. */
	async function connect(v: DropVerdict, anchor?: string): Promise<boolean> {
		let folded = false;
		for (const s of [v.from, v.to]) {
			if (s?.kind !== 'sample') continue;
			const had = !!sampleItemOf(edit.body.value, s.id);
			if (!(await ensureSample(s.id, { merge: folded }))) return false;
			if (!had) folded = true;
		}
		// The row a free socket stands for (when one does) and the wire: one step.
		const actions = connectActions(edit.body.value, v);
		if (!actions) return false;
		const before = edit.body.value;
		edit.apply(actions, { anchor, merge: folded });
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
		// A free socket is a button with nothing wired to it, though its reference is the wired socket's of the same row; a wired one is a Handle.
		const free = !!el.classList?.contains('free');
		const socketId = free ? null : (el.dataset.handleid ?? null);
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
			else if (onEmptyCanvas(ev.clientX, ev.clientY)) {
				// A wired input, dragged off and let go on empty canvas, takes the wire off (R4); a free socket, or one with no wire, opens the menu.
				if (socketId && o.dropWire?.(sock, socketId)) return;
				o.openMenu({ sock, at: { x: ev.clientX, y: ev.clientY }, flow: canvas.toFlow(ev.clientX, ev.clientY), anchor });
			}
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

	function openAt(sock: SocketRef, el: HTMLElement, connect: boolean): void {
		const r = el.getBoundingClientRect();
		const target: MenuTarget = { sock, at: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, anchor: (el.closest('.vue-flow__node') as HTMLElement | null)?.dataset.id };
		if (connect) o.openConnect?.(target);
		else o.openMenu(target);
	}
	/**
	 * Enter on a focused socket opens its menu, as a click does; C opens "Connect to…" (E21). Space does what Enter does on a socket that
	 * is not a <button> (a wired one: its Handle is a span with role button); on a real button Space arrives as a click (socketClick).
	 */
	function socketKey(sock: SocketRef, e: KeyboardEvent): void {
		const el = e.currentTarget as HTMLElement;
		const connect = e.key === 'c' || e.key === 'C';
		const space = e.key === ' ' && el.tagName?.toLowerCase() !== 'button';
		if ((e.key !== 'Enter' && !connect && !space) || e.ctrlKey || e.metaKey || e.altKey || !edit.editing.value) return;
		e.preventDefault();
		e.stopPropagation();
		openAt(sock, el, connect);
	}
	/** A click no pointer made (Space on a button, a screen reader's activate): the menu, like Enter. A pointer's click was handled on pointerdown. */
	function socketClick(sock: SocketRef, e: MouseEvent): void {
		if (e.detail !== 0 || !edit.editing.value) return;
		e.preventDefault();
		e.stopPropagation();
		openAt(sock, e.currentTarget as HTMLElement, false);
	}

	// ---- badges and ＋ output ---------------------------------------------------------------------------------------
	const blockers = computed(() => blocking(edit.checks.value));
	const warned = computed(() => warnings(edit.checks.value));
	/** What a card says about its checks: the things that block Create (red), else the warnings (amber); nothing when it has none. */
	function badge(node: MapNode): { count: number; text: string; level: 'block' | 'warn' } | null {
		const keys = draftKeysOfNode(edit.body.value, node);
		if (!keys.length) return null;
		const mine = blockers.value.filter((c) => keys.includes(c.key));
		if (mine.length) return { count: mine.length, text: mine.map((c) => c.text).join(' '), level: 'block' };
		const soft = warned.value.filter((c) => keys.includes(c.key));
		return soft.length ? { count: soft.length, text: soft.map((c) => c.text).join(' '), level: 'warn' } : null;
	}
	/** The sockets of a card that have a wire: the rest are spare, and a card shows at most one free one per side (R5). */
	function wiredSockets(node: MapNode): ReadonlySet<string> {
		const out = new Set<string>();
		for (const w of map.graph.value?.wires ?? []) {
			if (nodeOfSocket(w.from) === node.id) out.add(w.from);
			if (nodeOfSocket(w.to) === node.id) out.add(w.to);
		}
		return out;
	}

	const mapEdit: Omit<MapEdit, MapEditRemoval> = { editing: edit.editing, drop, socketDown, socketKey, socketClick, badge, wiredSockets };

	if (getCurrentInstance()) {
		onBeforeUnmount(() => {
			stop?.();
			if (refusalTimer) clearTimeout(refusalTimer);
		});
	}

	return { mapEdit, preview, refusal, problem, ensureSample, connect, nodeById };
}
