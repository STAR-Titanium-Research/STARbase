// The Add menu's state and what a choice does on the draft (spec E8): where it is open, the entries' data, and, on a choice, the
// reducer actions as one undoable step with the new card placed where the person pointed (or beside the socket's card, which the
// layout does). A sample of the loaded history that the menu was opened on is added to the draft first.

import { shallowRef, type Ref } from 'vue';
import type { useMapCanvas } from '../useMapCanvas';
import { actionsFor, menuFor, type MenuChoice, type TemplateEntry } from './menuModel';
import type { MenuTarget } from './menuTarget';
import { resolveEnd, sampleItemOf } from './socketRefs';
import type { EditMode } from './useEditMode';

type Canvas = ReturnType<typeof useMapCanvas>;

export function useAddMenu(o: {
	edit: EditMode;
	canvas: Pick<Canvas, 'toFlow'>;
	canvasEl: Ref<HTMLElement | null>;
	ensureSample: (recordId: string) => Promise<boolean>;
	/** The sample picker over the canvas. */
	pickSamples: () => void;
	/** Saved templates for the menu (stream E); none until it lands. */
	templates?: () => TemplateEntry[];
}) {
	const target = shallowRef<MenuTarget | null>(null);

	/** The canvas's own rectangle, to keep an unconnected menu's card on the canvas. */
	const canvasRect = () => o.canvasEl.value?.getBoundingClientRect();

	/** Opens the menu. An unconnected menu puts its card at the point it opened on (inside the canvas), or the middle of the canvas. */
	function open(t: MenuTarget): void {
		if (!o.edit.editing.value) return;
		const r = canvasRect();
		let flow = t.flow;
		if (!flow && !t.sock) {
			const inside = !!r && t.at.x >= r.left && t.at.x <= r.right && t.at.y >= r.top && t.at.y <= r.bottom;
			const x = inside || !r ? t.at.x : r.left + r.width / 2;
			const y = inside || !r ? t.at.y : r.top + r.height / 2;
			flow = o.canvas.toFlow(x, y);
		}
		target.value = { ...t, ...(flow ? { flow } : {}) };
	}
	const close = (): void => void (target.value = null);

	async function choose(choice: MenuChoice): Promise<void> {
		const t = target.value;
		if (!t) return;
		close();
		if (choice.kind === 'pickSamples') return o.pickSamples();
		// What the socket is: a sample of the loaded history joins the draft first (with the version it was read at).
		if (t.sock?.kind === 'sample' && !sampleItemOf(o.edit.body.value, t.sock.id) && !(await o.ensureSample(t.sock.id))) return;
		let resolved = choice;
		if (choice.kind === 'record') {
			if (!(await o.ensureSample(choice.id))) return;
			const key = sampleItemOf(o.edit.body.value, choice.id)?.key;
			if (!key) return;
			resolved = { kind: 'wireSample', key };
		}
		const body = o.edit.body.value;
		const f = menuFor(body, t.sock);
		const actions = actionsFor({ body, end: t.sock ? resolveEnd(body, t.sock) : null, side: f.side, card: f.card, at: t.flow }, resolved);
		if (actions.length) o.edit.apply(actions, { anchor: t.anchor });
	}

	return { target, open, close, choose };
}
