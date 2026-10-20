<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { canvasSampleEntries, firstChoosable, menuFor, moveActive, operationOnlyEntries, placeMenu, rootEntries, sampleLabel, searchEntries, type MenuChoice, type MenuEntry } from './menuModel';
import { grown } from './socketRefs';
import type { TemplateItem } from './templates';
import type { MenuTarget } from './menuTarget';
import { restoreFocus as giveFocusBack } from './focusCanvas';

// The add search (redesign R1, R2): a search box and a list at a point of the canvas. Shift+A or Ctrl/⌘+K open it at the pointer (or at the
// focused card or socket); from a socket it lists only what can legally connect there (menuModel.ts), and what is chosen is connected.
// "Insert before / after" lists the operations that can go there. It is one flat list over the same catalog as the palette: type to narrow
// (the best match first, what was added lately before the rest), ArrowUp/ArrowDown move, Enter adds the top hit, Esc closes.
// "Existing sample…" switches the list to a search of the samples: the ones on the canvas for an output, the database for an input.
const props = defineProps<{
	target: MenuTarget;
	body: DraftBody;
	methods: MethodEntry[];
	testTypes: TestTypeEntry[];
	/** The templates this person may use (R7): listed first, found by name or method. */
	templates?: readonly TemplateItem[];
	/** What this person added lately (entry ids, newest first): listed first. */
	recents?: string[];
	/** Searches the samples of the database by code or nickname. */
	search?: (query: string) => Promise<{ id: string; code: string; detail: string }[]>;
	/** The code of an existing sample of the draft, for the list of samples on the canvas. */
	codeOf?: (id: string) => string | undefined;
	/** Where focus goes when the element that had it before the search opened is gone (the right-click menu): the selected card. */
	restoreFocus?: (anchor?: string) => void;
}>();
const emit = defineEmits<{ choose: [choice: MenuChoice]; close: [] }>();

const uid = useId();
const purpose = computed(() => menuFor(props.body, props.target.sock));
/** The draft the entries are asked about: with the row a free socket stands for, when it stands for one. */
const view = computed(() => (props.target.sock?.add ? (grown(props.body, props.target.sock)?.body ?? props.body) : props.body));
const query = ref('');
/** 'root': the catalog; 'canvas': samples on the canvas; 'records': a search of the database. */
const mode = ref<'root' | 'canvas' | 'records'>('root');
const active = ref(-1);

const found = ref<MenuEntry[]>([]);
const searching = ref(false);
const searchFailed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let asked = 0;
watch([query, mode], () => {
	if (timer) clearTimeout(timer);
	if (mode.value !== 'records' || !props.search) return;
	const q = query.value.trim();
	found.value = [];
	searchFailed.value = false;
	if (q.length < 2) return void (searching.value = false);
	searching.value = true;
	const mine = ++asked;
	timer = setTimeout(async () => {
		try {
			const rows = await props.search!(q);
			if (mine !== asked) return;
			found.value = rows.map((r) => ({ id: `rec:${r.id}`, section: 'Samples', label: r.code, detail: r.detail || undefined, choice: { kind: 'record', id: r.id, code: r.code } }));
		} catch {
			if (mine === asked) searchFailed.value = true;
		} finally {
			if (mine === asked) searching.value = false;
		}
	}, 200);
});

const all = computed<MenuEntry[]>(() => {
	if (mode.value === 'records') return found.value;
	if (mode.value === 'canvas') return canvasSampleEntries(view.value, purpose.value.end, (key) => sampleLabel(props.body, key, props.codeOf ?? (() => undefined)));
	const ins = props.target.insert;
	if (ins) return operationOnlyEntries({ methods: props.methods, testTypes: props.testTypes, templates: props.templates });
	return rootEntries(view.value, purpose.value, { methods: props.methods, testTypes: props.testTypes, templates: props.templates });
});
// The search of the database is the server's: its rows are not filtered again by the same words. The catalog is ranked, recents first.
const entries = computed(() => (mode.value === 'records' ? all.value : searchEntries(all.value, query.value, mode.value === 'root' ? (props.recents ?? []) : [])));
/** Section headers only while nothing is typed: a ranked answer is one list, each row says its own category. */
const grouped = computed(() => !query.value.trim());
/** What the list has to say instead of entries (and what the status region announces); empty while there are some. */
const message = computed(() => {
	if (mode.value === 'records' && query.value.trim().length < 2) return 'Type at least two letters of the code.';
	if (mode.value === 'records' && searching.value) return 'Searching…';
	if (searchFailed.value) return 'The search failed. Try again.';
	if (!entries.value.length) return mode.value === 'root' ? 'Nothing fits what you typed.' : mode.value === 'canvas' ? 'No samples on the canvas.' : 'No samples found.';
	return '';
});
watch(entries, (list) => void (active.value = firstChoosable(list)), { immediate: true });

/** The entries with a header before each new section (while nothing is typed). */
const rows = computed(() => entries.value.map((e, i) => ({ e, i, head: grouped.value && (i === 0 || entries.value[i - 1].section !== e.section) ? e.section : null })));
const optionId = (i: number) => `${uid}-opt-${i}`;

const title = computed(() => {
	if (mode.value === 'records') return 'Find a sample';
	if (mode.value === 'canvas') return 'Samples on the canvas';
	const ins = props.target.insert;
	if (ins) return `Insert ${ins.where} ${ins.what}`;
	const f = purpose.value;
	if (f.side === 'out' && f.card === 'operation') return 'What does this operation make?';
	if (f.side === 'in' && f.card !== 'sample') return 'What feeds this in?';
	if (f.side === 'in') return 'What makes this sample?';
	if (f.side === 'out') return 'What happens to this sample?';
	return 'Add';
});
const placeholder = computed(() => (mode.value === 'records' ? 'Sample code or nickname…' : mode.value === 'canvas' ? 'Filter the samples…' : 'Search operations, tests, samples…'));

function choose(e: MenuEntry | undefined) {
	if (!e || e.disabled) return;
	if (e.choice.kind === 'existingSample') {
		// An output takes a sample already on the canvas; an input searches the database.
		mode.value = purpose.value.side === 'in' && props.search ? 'records' : 'canvas';
		query.value = '';
		void nextTick(() => input.value?.focus());
		return;
	}
	emit('choose', e.choice);
}
function back() {
	mode.value = 'root';
	query.value = '';
	void nextTick(() => input.value?.focus());
}
function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		if (mode.value !== 'root') back();
		else emit('close');
	} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		active.value = moveActive(entries.value, active.value, e.key === 'ArrowDown' ? 1 : -1);
		void nextTick(() => list.value?.querySelector(`[id="${optionId(active.value)}"]`)?.scrollIntoView?.({ block: 'nearest' }));
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		choose(entries.value[active.value]);
	} else if (e.key === 'Tab') {
		e.preventDefault(); // the search is one place: Tab does not leave it for the page behind
	}
}

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const box = ref<HTMLElement | null>(null);
const pos = ref<{ left: number; top: number }>({ left: props.target.at.x, top: props.target.at.y });
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
function place() {
	const r = box.value?.getBoundingClientRect();
	if (!r) return;
	pos.value = placeMenu(props.target.at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight });
}
onMounted(async () => {
	input.value?.focus();
	await nextTick();
	place();
});
// The list grows and shrinks as the person types: keep the box in the window.
watch(entries, () => void nextTick(place));
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	giveFocusBack(opener, () => props.restoreFocus?.(props.target.anchor));
});
</script>

<template>
	<div class="pm-addsearch-back" @pointerdown.self="emit('close')" @contextmenu.prevent="emit('close')">
		<!-- aria-modal: a dialog is in front, so Ctrl/⌘+K does not open the shell's Finder over it. -->
		<div ref="box" class="d1-kit d1-process-map pm-addsearch" role="dialog" aria-modal="true" :aria-label="title" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" @keydown="onKey">
			<div class="top">
				<button v-if="mode !== 'root'" type="button" class="back" aria-label="Back" @click="back"><v-icon name="arrow_back" x-small /></button>
				<span class="ttl">{{ title }}</span>
			</div>
			<input
				ref="input"
				v-model="query"
				class="q"
				type="text"
				role="combobox"
				autocomplete="off"
				spellcheck="false"
				:placeholder="placeholder"
				:aria-label="title"
				aria-expanded="true"
				:aria-controls="`${uid}-list`"
				:aria-activedescendant="active >= 0 ? optionId(active) : undefined"
			/>
			<div :id="`${uid}-list`" ref="list" class="list" role="listbox">
				<template v-for="r in rows" :key="r.e.id">
					<div v-if="r.head" class="sec" role="presentation">{{ r.head }}</div>
					<button
						:id="optionId(r.i)"
						type="button"
						role="option"
						class="opt"
						:class="{ on: r.i === active, off: !!r.e.disabled, grey: !!r.e.warn }"
						:aria-selected="r.i === active"
						:aria-disabled="!!r.e.disabled || undefined"
						:title="r.e.disabled"
						tabindex="-1"
						@mousemove="!r.e.disabled && (active = r.i)"
						@click="choose(r.e)"
					>
						<span class="lab">{{ r.e.label }}</span>
						<span v-if="r.e.detail" class="det">{{ r.e.detail }}</span>
						<span v-if="!grouped && r.e.section" class="cat">{{ r.e.section }}</span>
						<span v-if="r.e.disabled" class="why">{{ r.e.disabled }}</span>
						<span v-else-if="r.e.warn" class="why warn">{{ r.e.warn }}</span>
					</button>
				</template>
			</div>
			<!-- One status region, always mounted: a live region that appears together with its text is often not announced. -->
			<p class="none" :class="{ bad: searchFailed && !searching, empty: !message }" role="status" aria-live="polite" aria-atomic="true">{{ message }}</p>
		</div>
	</div>
</template>

<style scoped>
.pm-addsearch-back { position: fixed; inset: 0; z-index: 60; }
.pm-addsearch {
	position: fixed;
	display: flex;
	flex-direction: column;
	gap: 6px;
	width: 320px;
	max-width: calc(100vw - 16px);
	padding: 8px;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 12px;
	box-shadow: var(--d1-shadow-lg, 0 10px 30px rgb(0 0 0 / 0.22));
	font-size: var(--fs-md, 13px);
}
.top { display: flex; align-items: center; gap: 6px; min-height: 22px; padding: 0 2px; }
.ttl { font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: none; color: inherit; cursor: pointer; }
.back:hover, .back:focus-visible { background: var(--d1-tile); outline: none; }
.q {
	box-sizing: border-box; width: 100%; padding: 7px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
.q:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
.list { display: flex; flex-direction: column; max-height: min(360px, 50vh); overflow: auto; }
.sec { padding: 8px 8px 3px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.opt {
	display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px;
	background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.opt.on { background: var(--d1-tint); box-shadow: inset 3px 0 0 var(--d1-accent, var(--theme--primary)); }
.opt.off { cursor: default; opacity: 0.6; }
/* A template that names a retired machine or a used-up edge: still there to use, greyed, with the warning under it. */
.opt.grey .lab, .opt.grey .det { opacity: 0.6; }
.why.warn { color: var(--d1-warn, var(--theme--warning)); }
.lab { font-weight: 600; }
.det { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.cat { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.why { flex-basis: 100%; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.none { margin: 0; padding: 10px 8px; color: var(--d1-dim); }
.none.bad { color: var(--d1-bad); }
.none.empty { padding: 0; }
</style>
