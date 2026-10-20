<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { projectDatesText } from '@d1/ui';

// The About block of the Project hero: the dates, the document number (mono) and the description, clamped to four lines with
// "Show more" when it is longer than that. Whether it is longer is measured (the clamp hides the rest), so a short text never gets the button.
const props = defineProps<{ start: string | null; end: string | null; documentNumber: string | null; description: string | null }>();

const descId = useId();
const dates = computed(() => projectDatesText(props.start, props.end));
const text = ref<HTMLElement | null>(null);
const open = ref(false);
const overflowing = ref(false);

function measure() {
	const el = text.value;
	if (!el || open.value) return;
	// Clamped: scrollHeight is the full text, clientHeight the four lines. Without layout (no measurement) fall back to the length.
	overflowing.value = el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : (props.description ?? '').length > 300;
}
let observer: ResizeObserver | null = null;
onMounted(() => {
	measure();
	if (text.value && typeof ResizeObserver !== 'undefined') {
		observer = new ResizeObserver(measure);
		observer.observe(text.value);
	}
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => props.description, () => nextTick(measure));
</script>

<template>
	<div class="about">
		<h2 class="d1-sr-only">About</h2>
		<div class="facts">
			<span><span class="k">Dates</span><span class="v">{{ dates }}</span></span>
			<span v-if="documentNumber"><span class="k">Document</span><span class="v mono">{{ documentNumber }}</span></span>
		</div>
		<p v-if="description" :id="descId" ref="text" class="desc" :class="{ open }">{{ description }}</p>
		<p v-else class="desc none">No description yet.</p>
		<button v-if="description && (overflowing || open)" type="button" class="more" :aria-expanded="open" :aria-controls="descId" @click="open = !open">
			{{ open ? 'Show less' : 'Show more' }}
		</button>
	</div>
</template>

<style scoped>
.about { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.facts { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--fs-sm, 12px); }
.k { color: var(--d1-dim); margin-right: 4px; }
.v { font-weight: 600; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.desc {
	margin: 0; max-width: 92ch; color: var(--d1-dim); font-size: var(--fs-md, 13px); line-height: 1.45; white-space: pre-line;
	display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.desc.open { display: block; -webkit-line-clamp: unset; }
.desc.none { font-style: italic; }
.more {
	align-self: flex-start; padding: 2px 0; border: 0; background: none; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer;
}
.more:hover { text-decoration: underline; }
.more:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 2px; }
</style>
