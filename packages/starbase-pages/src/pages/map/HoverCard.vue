<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RecordRail, StatusBadge, hasDrawableDims, sampleDims } from '@d1/ui';
import SampleGeometry from '../sample/SampleGeometry.vue';
import type { ElementRow } from '@d1/ui';
import DataThumb from './DataThumb.vue';
import MaterialComposition from './MaterialComposition.vue';
import { placeCard, type Placement } from './model/placeCard';
import type { DataPreview } from './model/dataPreview';
import type { RecordInfo } from './model/recordInfo';
import { KINDS, kindVar, statusKindOf } from './nodes/kinds';

// The hover card (spec D16, §6.6): the rail's identity block, a data thumbnail when the record has
// data, the facts and counts, and a hint line, raised beside the hovered element inside the canvas. It
// A material also shows its nominal composition once that has been read (the page reads it on hover).
// It opens after the page's 250 ms delay (the page mounts it then), goes to the right of the element, flips
// to its left and then below to stay inside the canvas, and takes no pointer and no focus: it is
// aria-hidden, the same facts are in the rail when the record is selected.
const props = defineProps<{ info: RecordInfo; preview?: DataPreview; composition?: ElementRow[] | null; target: HTMLElement; canvas: HTMLElement }>();

const style = computed(() => KINDS[props.info.kind]);
const drawable = computed(() => !!props.info.geometry && hasDrawableDims(props.info.geometry));
const dims = computed(() => sampleDims(props.info.geometry));

const root = ref<HTMLElement | null>(null);
const placed = ref<Placement | null>(null);
async function place(): Promise<void> {
	await nextTick(); // the data thumbnail changes the height
	const el = root.value;
	if (!el || !props.target.isConnected) return;
	placed.value = placeCard(props.target.getBoundingClientRect(), props.canvas.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight });
}
onMounted(place);
watch(() => [props.target, props.info.id, props.preview, props.composition], place);
</script>

<template>
	<div
		ref="root"
		class="hover-card"
		:class="{ placed: !!placed }"
		:style="{ '--k': kindVar(style), ...(placed ? { left: `${placed.left}px`, top: `${placed.top}px` } : {}) }"
		aria-hidden="true"
	>
		<RecordRail :kind="style.label" :code="info.code" :plain="info.plain" :title="info.title" :facts="info.facts">
			<template #kind-icon><v-icon :name="style.icon" x-small /></template>
			<template #status><StatusBadge :kind="statusKindOf(info.kind)" :value="info.status" /></template>
			<template v-if="drawable || (preview && preview.kind !== 'none')" #extra>
				<div v-if="drawable" class="geo"><SampleGeometry :dims="dims" :label-size="15" /></div>
				<DataThumb :preview="preview" />
			</template>
			<template #after-facts>
				<MaterialComposition v-if="info.kind === 'material'" :elements="composition" class="comp" />
				<div v-if="info.counts.length" class="counts">
					<span v-for="c in info.counts" :key="c.label"><b>{{ c.value }}</b> {{ c.label }}</span>
				</div>
				<div class="hint">Click to select · ＋ to show more</div>
			</template>
		</RecordRail>
	</div>
</template>

<style scoped>
.hover-card {
	position: absolute;
	z-index: 20;
	width: 300px;
	pointer-events: none;
	/* Measured before it is placed, so it cannot flash at the corner. */
	opacity: 0;
	transform: translateY(4px);
	transition: opacity 0.12s, transform 0.12s;
}
.hover-card.placed { opacity: 1; transform: none; }
.hover-card :deep(.d1-record-rail) { gap: 10px; box-shadow: var(--d1-shadow-lg, var(--d1-shadow)); }
.hover-card :deep(.code) { font-size: var(--fs-lg, 15px); }
.hover-card :deep(.kind) {
	color: color-mix(in srgb, var(--k) 62%, var(--theme--foreground));
	background: color-mix(in srgb, var(--k) 14%, transparent);
}
/* Most of the card's width, so the shape and its dimensions read at a glance (labels sized for ~200px). */
.geo { width: 100%; max-width: 220px; margin: 0 auto 6px; }
.comp { margin-bottom: 8px; }
.counts { display: flex; flex-wrap: wrap; gap: 0 14px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.counts b { font-size: var(--fs-md, 13px); color: var(--theme--foreground); font-variant-numeric: tabular-nums; }
.hint { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--d1-line); font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.counts + .hint { margin-top: 8px; }
</style>
