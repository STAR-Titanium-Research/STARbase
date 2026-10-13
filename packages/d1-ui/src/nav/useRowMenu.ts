import { computed, nextTick, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { linkHref, openLinkInNewTab } from '../links';
import { copyLink, rowMenuItems } from './rowMenu';
import { pinKey } from './sidebarModel';
import type { PinRef, ResolvedPin } from './sidebarModel';
import type { PinsState } from './usePins';

export interface OpenRowMenu {
	key: string;
	kind: 'section' | 'pinned';
	to: string;
	ref: PinRef | null;
	label: string;
	anchor: DOMRect;
	edge: number;
}

// The state behind the sidebar's row "⋯" menu: which row it is open for, its items, and what each
// item does. The menu component only draws it. `focusButton(key)` puts focus back on a row's "⋯" button.
export function useRowMenu(o: {
	pins: PinsState;
	shown: ComputedRef<ResolvedPin[]>;
	ready: () => boolean;
	// The sidebar's element: the menu opens beside its right edge.
	root: Ref<HTMLElement | null>;
	focusButton: (key: string) => void;
	movePin: (ref_: PinRef, delta: -1 | 1) => void;
	say: (text: string) => void;
}) {
	const route = useRoute();
	const router = useRouter();
	const menu = ref<OpenRowMenu | null>(null);

	function openMenu(key: string, kind: 'section' | 'pinned', item: { to: string; label: string }, ref_: PinRef | null, anchor: DOMRect) {
		// The "⋯" button toggles its own menu.
		if (menu.value?.key === key) {
			menu.value = null;
			return;
		}
		menu.value = {
			key, kind, to: item.to, ref: ref_, label: item.label, anchor,
			edge: o.root.value?.getBoundingClientRect().right ?? anchor.right,
		};
	}

	function closeMenu(refocus: boolean) {
		const m = menu.value;
		menu.value = null;
		if (refocus && m) void nextTick(() => o.focusButton(m.key));
	}

	const items = computed(() => {
		const m = menu.value;
		if (!m) return [];
		const shown = o.shown.value;
		const index = m.ref ? shown.findIndex((r) => pinKey(r.ref) === pinKey(m.ref!)) : -1;
		return rowMenuItems({
			kind: m.kind,
			pinned: !!m.ref && o.pins.isPinned(m.ref),
			canPin: o.ready() && !!m.ref,
			index,
			count: shown.length,
		});
	});

	async function choose(id: string) {
		const m = menu.value;
		if (!m) return;
		closeMenu(true);
		if (id === 'pin' || id === 'unpin') {
			if (m.ref) void o.pins.toggle(m.ref);
		} else if (id === 'up' || id === 'down') {
			if (m.ref) o.movePin(m.ref, id === 'up' ? -1 : 1);
		} else if (id === 'new-tab') {
			openLinkInNewTab(m.to, router);
		} else if (id === 'copy') {
			o.say((await copyLink(linkHref(m.to, router))) ? 'Link copied' : "Couldn't copy the link");
		}
	}

	// Another page: the menu would sit beside the wrong row.
	watch(() => route.fullPath, () => { menu.value = null; });

	return { menu, items, openMenu, closeMenu, choose };
}
