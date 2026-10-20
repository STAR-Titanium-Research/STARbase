<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRecordView } from '../composables/useRecordView';
import { contentsModel, type ContentsEntry } from '../record/contents';
import { withoutEmpty } from '../record/recordView';
import { findScrollParent } from '../record/scrollParent';
import { scrollToSection } from '../record/scrollTo';

// "On this page": the page's sections with their counts. The section in view is marked, a click
// scrolls to a section, and an empty section is listed dimmed. The model is record/contents.ts; this
// renders it and feeds it the ids an IntersectionObserver reports. When the page's View rail hides empty
// sections (useRecordView), they leave the list and a line says how many ("2 empty sections hidden").
//
// The observer's root is the scroller of the sections: the nearest scrolling ancestor that contains
// them (the Data Studio scrolls inside its own container, not the window; null = the viewport). The
// rail is itself a scroller (overflow: auto) and sits beside the sections, so a scroller that does not
// contain a section is skipped. It is found when the first section exists in the document. Everything
// that touches the document or the observer is guarded, so the component also renders where there is
// none (tests, server).
const props = defineProps<{ entries: ContentsEntry[] }>();

const view = useRecordView();
const listed = computed(() => withoutEmpty(props.entries, view?.empty === 'hide'));

const root = ref<HTMLElement | null>(null);
const inView = ref(new Set<string>());
const atBottom = ref(false);
const visible = computed(() => {
	// A short last section can never reach the upper 60% where the page is scrolled to its end: at the
	// bottom the last entry is the current one.
	const last = listed.value.shown[listed.value.shown.length - 1];
	return atBottom.value && last ? new Set([last.id]) : inView.value;
});
const model = computed(() => contentsModel(listed.value.shown, visible.value));

let observer: IntersectionObserver | null = null;
let scroller: Element | null = null;
let scrollTarget: EventTarget | null = null;
let resolved = false;

function measureBottom() {
	const el = scroller ?? document.documentElement;
	atBottom.value = el.scrollHeight > el.clientHeight + 2 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

function listen(target: EventTarget | null) {
	if (scrollTarget === target) return;
	scrollTarget?.removeEventListener('scroll', measureBottom);
	scrollTarget = target;
	scrollTarget?.addEventListener('scroll', measureBottom, { passive: true });
}

function observe() {
	if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined' || !root.value) return;
	const els = listed.value.shown.map((e) => document.getElementById(e.id)).filter((el): el is HTMLElement => !!el);
	// The scroller is found from a section, so with none in the document yet it is looked for again
	// on the next call (the page adds its sections as the data arrives).
	if (!resolved && els.length) {
		scroller = findScrollParent<Element>(root.value, (el) => getComputedStyle(el), (el) => el.contains(els[0]));
		resolved = true;
		listen(scroller ?? window);
	}
	observer?.disconnect();
	inView.value = new Set();
	observer = new IntersectionObserver(
		(changes) => {
			const next = new Set(inView.value);
			for (const c of changes) {
				if (c.isIntersecting) next.add(c.target.id);
				else next.delete(c.target.id);
			}
			inView.value = next;
		},
		// A section counts as in view while it is in the upper 60% of the scroll area, so the one being
		// read is current rather than the one just peeking in at the bottom edge.
		{ root: scroller, rootMargin: '0px 0px -40% 0px', threshold: 0 },
	);
	for (const el of els) observer.observe(el);
	measureBottom();
}

onMounted(observe);
// The page adds its sections as their data arrives (a v-if, a request): observe again when the list
// or a count changes.
watch(
	() => listed.value.shown.map((e) => `${e.id}:${e.count}`).join('|'),
	() => nextTick(observe),
);
onBeforeUnmount(() => {
	observer?.disconnect();
	observer = null;
	listen(null);
});

function go(id: string, event: MouseEvent) {
	// A new-tab or new-window click keeps the link's own behaviour (the helper declines it).
	scrollToSection(id, event);
}
</script>

<template>
	<nav v-if="entries.length" ref="root" class="d1-page-contents" aria-label="On this page">
		<h2>On this page</h2>
		<a
			v-for="e in model"
			:key="e.id"
			:href="`#${e.id}`"
			class="entry"
			:class="{ current: e.current, empty: e.empty }"
			:aria-current="e.current ? 'location' : undefined"
			@click="go(e.id, $event)"
		>
			<span class="title">{{ e.title }}</span>
			<span v-if="e.count !== null" class="count">{{ e.count }}</span>
		</a>
		<p v-if="listed.hidden" class="hidden-note">{{ listed.hidden }} empty section{{ listed.hidden === 1 ? '' : 's' }} hidden</p>
	</nav>
</template>

<style scoped>
.d1-page-contents { display: flex; flex-direction: column; }
h2 {
	margin: 0 0 4px;
	padding-bottom: 4px;
	font-size: var(--fs-sm, 12px);
	font-weight: 650;
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.entry {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 10px;
	padding: 3px 0 3px 8px;
	border-left: 2px solid transparent;
	font-size: var(--fs-md, 13px);
	color: var(--theme--foreground);
	text-decoration: none;
}
.entry:hover .title { text-decoration: underline; }
.count { font-variant-numeric: tabular-nums; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.current { border-left-color: var(--d1-accent, var(--theme--primary)); font-weight: 650; }
.empty { opacity: 0.55; }
.hidden-note { margin: 0; padding: 3px 0 3px 10px; font-size: var(--fs-md, 13px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
</style>
