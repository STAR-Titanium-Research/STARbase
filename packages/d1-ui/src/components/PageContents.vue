<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { contentsModel, type ContentsEntry } from '../record/contents';
import { findScrollParent } from '../record/scrollParent';

// "On this page": the page's sections with their counts. The section in view is marked, a click
// scrolls to a section, and an empty section is listed dimmed. The model is record/contents.ts; this
// renders it and feeds it the ids an IntersectionObserver reports.
//
// The observer's root is the nearest scrolling ancestor, found once on mount: the Data Studio scrolls
// inside its own container, not the window (null = the viewport). Everything that touches the document
// or the observer is guarded, so the component also renders where there is none (tests, server).
const props = defineProps<{ entries: ContentsEntry[] }>();

const root = ref<HTMLElement | null>(null);
const visible = ref(new Set<string>());
const model = computed(() => contentsModel(props.entries, visible.value));

let observer: IntersectionObserver | null = null;
let scroller: Element | null = null;
let found = false;

function observe() {
	if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined' || !root.value) return;
	if (!found) {
		scroller = findScrollParent<Element>(root.value, (el) => getComputedStyle(el));
		found = true;
	}
	observer?.disconnect();
	visible.value = new Set();
	observer = new IntersectionObserver(
		(changes) => {
			const next = new Set(visible.value);
			for (const c of changes) {
				if (c.isIntersecting) next.add(c.target.id);
				else next.delete(c.target.id);
			}
			visible.value = next;
		},
		// A section counts as in view while it is in the upper 60% of the scroll area, so the one being
		// read is current rather than the one just peeking in at the bottom edge.
		{ root: scroller, rootMargin: '0px 0px -40% 0px', threshold: 0 },
	);
	for (const e of props.entries) {
		const el = document.getElementById(e.id);
		if (el) observer.observe(el);
	}
}

onMounted(observe);
// The page adds its sections as their data arrives: observe again when the list changes.
watch(
	() => props.entries.map((e) => e.id).join('|'),
	() => nextTick(observe),
);
onBeforeUnmount(() => {
	observer?.disconnect();
	observer = null;
});

function go(id: string, event: Event) {
	if (typeof document === 'undefined') return;
	const el = document.getElementById(id);
	if (!el) return;
	event.preventDefault();
	el.scrollIntoView({ block: 'start' });
	// The hash is for sharing the place; replaceState keeps the router state and starts no navigation.
	if (typeof history !== 'undefined') history.replaceState(history.state, '', `#${id}`);
}
</script>

<template>
	<nav v-if="entries.length" ref="root" class="d1-page-contents" aria-label="On this page">
		<h3>On this page</h3>
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
	</nav>
</template>

<style scoped>
.d1-page-contents { display: flex; flex-direction: column; }
h3 {
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
</style>
