// The add search's state and what a choice does on the draft (redesign R1, R2): where it is open, and, on a choice, the reducer actions as
// one undoable step with the new card placed where the person pointed (or beside the socket's card, which the layout does). A sample of the
// loaded history that the search was opened on is added to the draft first. `applyAt` is the same step for the palette: a drop on a socket
// and Enter on an entry do what a choice in the search does.

import { ref, shallowRef, watch, type Ref } from 'vue';
import type { useMapCanvas } from '../useMapCanvas';
import { actionsFor, menuFor, type MenuChoice } from './menuModel';
import type { MenuTarget } from './menuTarget';
import { pushRecent, readRecents, recentIdOf } from './recents';
import { grown, resolveEnd, sampleItemOf } from './socketRefs';
import type { EditMode } from './useEditMode';

type Canvas = ReturnType<typeof useMapCanvas>;

export function useAddMenu(o: {
	edit: EditMode;
	canvas: Pick<Canvas, 'toFlow'>;
	canvasEl: Ref<HTMLElement | null>;
	ensureSample: (recordId: string, opts?: { merge?: boolean }) => Promise<boolean>;
	/** The sample picker over the canvas. */
	pickSamples: () => void;
	/** "Connect to…" for the socket the search was opened on. */
	connect: (t: MenuTarget) => void;
	/** Who is building (the recents are theirs). */
	person?: () => string | null | undefined;
	/** A choice made in an "Insert before / after" search: the page decides what it does (insertModel.ts). */
	insert?: (t: MenuTarget, choice: MenuChoice) => Promise<boolean | void> | boolean | void;
}) {
	const target = shallowRef<MenuTarget | null>(null);
	/** What this person added lately (entry ids, newest first). Read when the person is known (a moment after the page opens), and again on every open. */
	const recents = ref<string[]>([]);
	watch(() => o.person?.(), (p) => void (recents.value = readRecents(p)), { immediate: true });

	/** The canvas's own rectangle, to keep an unconnected search's card on the canvas. */
	const canvasRect = () => o.canvasEl.value?.getBoundingClientRect();

	/** Opens the search. An unconnected one puts its card at the point it opened on (inside the canvas), or the middle of the canvas. */
	function open(t: MenuTarget): void {
		if (!o.edit.editing.value) return;
		recents.value = readRecents(o.person?.());
		const r = canvasRect();
		let flow = t.flow;
		if (!flow && !t.sock && !t.insert) {
			const inside = !!r && t.at.x >= r.left && t.at.x <= r.right && t.at.y >= r.top && t.at.y <= r.bottom;
			const x = inside || !r ? t.at.x : r.left + r.width / 2;
			const y = inside || !r ? t.at.y : r.top + r.height / 2;
			flow = o.canvas.toFlow(x, y);
		}
		target.value = { ...t, ...(flow ? { flow } : {}) };
	}
	const close = (): void => void (target.value = null);

	/** Does a choice at a target: a socket (connected there), the empty canvas (a floating card at `flow`) or an insert. */
	async function applyAt(t: MenuTarget, choice: MenuChoice): Promise<void> {
		if (choice.kind === 'pickSamples') return o.pickSamples();
		if (choice.kind === 'connectTo') return void o.connect(t);
		// What was added lately is noted only once the choice did something: a refused drop or insert, or one that changed nothing, is no "recent".
		const recent = recentIdOf(choice);
		const note = (): void => void (recent && (recents.value = pushRecent(o.person?.(), recent)));
		if (t.insert || choice.kind === 'earlierStep') return void ((await o.insert?.(t, choice)) !== false && note());
		// What the socket is: a sample of the loaded history joins the draft first (with the version it was read at).
		// The samples it adds and the choice made on them are one undo step.
		let folded = false;
		if (t.sock?.kind === 'sample' && !sampleItemOf(o.edit.body.value, t.sock.id)) {
			if (!(await o.ensureSample(t.sock.id))) return;
			folded = true;
		}
		let resolved = choice;
		if (choice.kind === 'record') {
			const had = !!sampleItemOf(o.edit.body.value, choice.id);
			if (!(await o.ensureSample(choice.id, { merge: folded }))) return;
			if (!had) folded = true;
			const key = sampleItemOf(o.edit.body.value, choice.id)?.key;
			if (!key) return;
			resolved = { kind: 'wireSample', key };
		}
		// A free socket that stands for a new row adds it first, in the same step.
		const g = t.sock ? grown(o.edit.body.value, t.sock) : { body: o.edit.body.value, action: null };
		if (!g) return;
		const body = g.body;
		const f = menuFor(o.edit.body.value, t.sock); // (it reads a socket that adds a row as the body with the row itself)
		const actions = actionsFor({ body, end: t.sock ? resolveEnd(body, t.sock) : null, side: f.side, card: f.card, at: t.flow }, resolved);
		if (!actions.length) return;
		o.edit.apply([...(g.action ? [g.action] : []), ...actions], { anchor: t.anchor, merge: folded });
		note();
	}

	async function choose(choice: MenuChoice): Promise<void> {
		const t = target.value;
		if (!t) return;
		close();
		await applyAt(t, choice);
	}

	return { target, recents, open, close, choose, applyAt };
}
