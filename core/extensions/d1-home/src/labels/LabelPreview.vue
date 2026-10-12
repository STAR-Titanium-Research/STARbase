<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

// The live preview: the label document in a sandboxed iframe (no scripts; same-origin only so this page can
// read the height of its content), scaled to the width of the column. The labels stay white paper in dark
// mode, the stage round them follows the theme.
const props = defineProps<{ html: string | null; pageWidthMm: number }>();

const PX_PER_MM = 96 / 25.4;
const MAX_SCALE = 3;

const frame = ref<HTMLIFrameElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const stageWidth = ref(0);
const contentHeight = ref(0);

// A millimetre of room each side for the page's shadow.
const naturalWidth = computed(() => (props.pageWidthMm + 2) * PX_PER_MM);
const scale = computed(() => (stageWidth.value > 0 ? Math.min(MAX_SCALE, stageWidth.value / naturalWidth.value) : 1));

function measureContent(): void {
	const el = frame.value;
	const root = el?.contentDocument?.documentElement;
	if (!el || !root) return;
	// scrollHeight never drops below the frame's own height: shrink it first, so a shorter document reads right.
	el.style.height = '0px';
	const h = root.scrollHeight;
	el.style.height = `${h}px`;
	contentHeight.value = h;
}

let observer: ResizeObserver | undefined;
onMounted(() => {
	if (!stage.value) return;
	const read = () => {
		const cs = stage.value ? getComputedStyle(stage.value) : null;
		const pad = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0;
		stageWidth.value = Math.max(0, (stage.value?.clientWidth ?? 0) - pad);
	};
	read();
	observer = new ResizeObserver(read);
	observer.observe(stage.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<div ref="stage" class="stage">
		<div v-if="html" class="fit" :style="{ width: `${naturalWidth * scale}px`, height: `${contentHeight * scale}px` }">
			<!-- color-scheme: light keeps the browser from painting an opaque backdrop behind the (transparent) document in a dark theme. -->
			<iframe
				ref="frame"
				title="Label preview"
				sandbox="allow-same-origin"
				scrolling="no"
				:srcdoc="html"
				:style="{ width: `${naturalWidth}px`, transform: `scale(${scale})` }"
				@load="measureContent"
			/>
		</div>
	</div>
</template>

<style scoped>
.stage {
	max-height: 70vh;
	overflow: auto;
	padding: 12px;
	border-radius: 8px;
	border: 1px solid var(--d1-line);
	background: var(--d1-tile);
}
.fit { margin: 0 auto; overflow: hidden; }
iframe {
	display: block;
	border: 0;
	transform-origin: 0 0;
	color-scheme: light;
	background: transparent;
}
</style>
