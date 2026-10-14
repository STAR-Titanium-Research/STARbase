// Picker mode of the index page: the list opened over another page (the process map's sample picker) to choose rows.
// Pure helpers; usePickMode.ts is the composable over them, IndexPage.vue the view.
//
// In picker mode the page keeps its search, saved views, filters, sorting and paging, but its state lives in memory,
// not in the URL: the page it is opened over (`/map?edit=…`) must keep its own address. Rows are ticked (a click
// on a row ticks it, nothing navigates); the confirm button hands them back with the rectangle each row had on
// screen at that moment, so the caller can fly them from there.
import { reactive } from 'vue';
import type { RouteLike, RouterLike } from './useIndexPage';

/**
 * A row chosen in picker mode: its key, its first column's text, and where it was on screen. `rect` is null when the row
 * was not drawn at the moment of confirming (ticked on another page, or filtered out since): a caller must cope with
 * that (a fly-in has nowhere to start from, so it just places the card).
 */
export interface PickedRow {
	id: string;
	code: string;
	rect: DOMRect | null;
}

/** Attribute that marks a row (or card) with its key, for measuring. */
export const PICK_ATTR = 'data-pick-key';

/** A route and router that keep the list's query in memory: what useIndexPage needs, with no address involved. */
export function memoryRoute(slug: string): { route: RouteLike; router: RouterLike } {
	const route = reactive<RouteLike>({ path: `/home/${slug}`, query: {}, params: { slug } });
	const apply = (to: { path: string; query: Record<string, string> }): void => {
		route.query = { ...to.query };
	};
	return { route, router: { push: apply, replace: apply } };
}

export interface PickNouns {
	one: string;
	many: string;
}

/** "Samples" -> sample / samples. A list whose title is not a plain plural passes its own nouns. */
export function nounsFor(title: string): PickNouns {
	const many = title.trim().toLowerCase();
	const words = many.split(' ');
	const last = words[words.length - 1];
	if (last === 'people') return { one: [...words.slice(0, -1), 'person'].join(' '), many };
	const singular = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.endsWith('s') ? last.slice(0, -1) : last;
	return { one: [...words.slice(0, -1), singular].join(' '), many };
}

/** The confirm button's text: "Add samples" with none ticked, "Add 1 sample", "Add 4 samples". */
export function pickText(count: number, nouns: PickNouns): string {
	if (count <= 0) return `Add ${nouns.many}`;
	return `Add ${count} ${count === 1 ? nouns.one : nouns.many}`;
}

export interface Measurable {
	querySelector(selector: string): { getBoundingClientRect(): DOMRect } | null;
}

/** The DOM element behind a template ref: the element itself, or a component's root; null when there is none to measure (server render). */
export function rootElement(root: unknown): Measurable | null {
	const el = (root as { $el?: unknown } | null)?.$el ?? root;
	return el && typeof (el as Measurable).querySelector === 'function' ? (el as Measurable) : null;
}

/** The on-screen rectangle of the row with this key under `root`, or null when it is not drawn (another page, filtered out). */
export function rectOf(root: Measurable | null | undefined, key: string): DOMRect | null {
	if (!root) return null;
	const el = root.querySelector(`[${PICK_ATTR}="${key.replace(/["\\]/g, '\\$&')}"]`);
	return el ? el.getBoundingClientRect() : null;
}

/** The ticked rows in the order they were ticked, each with its code and rectangle. `labels` holds the code of every ticked row, seen on whichever page. */
export function pickedRows(keys: readonly string[], labels: ReadonlyMap<string, string>, root: Measurable | null | undefined): PickedRow[] {
	return keys.map((id) => ({ id, code: labels.get(id) ?? id, rect: rectOf(root, id) }));
}
