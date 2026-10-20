// The palette's state (redesign R1): whether the dock is folded (remembered per person), what is typed in its search box, and the one catalog it
// lists, ranked like the add search (recents first). The list itself is menuModel.ts's `catalogEntries`, so the palette and the add search
// cannot disagree about what can be added.

import { computed, ref, watch, type Ref } from 'vue';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { catalogEntries, searchEntries, type MenuEntry } from './menuModel';
import { readFolded, writeFolded } from './recents';
import type { TemplateItem } from './templates';

export function usePalette(o: {
	methods: () => MethodEntry[];
	testTypes: () => TestTypeEntry[];
	/** The templates this person may use: the first group of the catalog (R7). */
	templates?: () => readonly TemplateItem[];
	recents: Ref<string[]>;
	person: () => string | null | undefined;
}) {
	const folded = ref(readFolded(o.person()));
	// The person is known a moment after the page opens: their own setting then replaces the default.
	watch(o.person, (p) => void (folded.value = readFolded(p)));
	const query = ref('');

	const all = computed<MenuEntry[]>(() => catalogEntries({ methods: o.methods(), testTypes: o.testTypes(), templates: o.templates?.() }));
	/** The entries the dock lists: the whole catalog, or what the search box finds. With nothing typed, what was added lately is on top. */
	const entries = computed(() => searchEntries(all.value, query.value, o.recents.value));
	/** Section headers while nothing is typed, as the add search does. */
	const grouped = computed(() => !query.value.trim());

	function toggle(): void {
		folded.value = !folded.value;
		writeFolded(o.person(), folded.value);
	}
	function fold(value: boolean): void {
		if (folded.value === value) return;
		folded.value = value;
		writeFolded(o.person(), value);
	}

	return { folded, query, entries, grouped, toggle, fold };
}

export type PaletteState = ReturnType<typeof usePalette>;
