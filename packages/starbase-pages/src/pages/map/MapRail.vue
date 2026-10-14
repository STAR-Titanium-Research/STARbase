<script setup lang="ts">
import { computed, ref } from 'vue';
import { RecordRail, Section, SegmentedControl, StatusBadge, hasDrawableDims, recordRoute, sampleDims } from '@d1/ui';
import SampleGeometry from '../sample/SampleGeometry.vue';
import DataThumb from './DataThumb.vue';
import { orderedGroups, type Connections } from './model/connections';
import type { DataPreview } from './model/dataPreview';
import type { RecordInfo } from './model/recordInfo';
import { KINDS, kindOfCollection, kindVar, statusKindOf } from './nodes/kinds';
import { SETTINGS_CHIP, type Reach } from './useProcessMap';

// The rail of the Process map (spec §6.5), from the top: the selected record's identity (kind, status,
// code, title), its actions (Open record, Expand, Centre), the sample drawing for a sample, the data
// thumbnail when it has data, its facts; then Connections (hover shows the hover card on the canvas,
// click selects and centres), Show (what the map draws) and Reach (how many steps). The page owns the
// state; this only draws it and reports what the person did.
const props = defineProps<{
	info: RecordInfo | null;
	preview?: DataPreview;
	/** The selected record is a card on the map (Expand and Centre need one). */
	onMap: boolean;
	connections: Connections;
	/** Node ids to show highlighted in Connections (a hovered socket's wires touch them). */
	highlight?: ReadonlySet<string>;
	presentKinds: string[];
	hiddenKinds: ReadonlySet<string>;
	probable: boolean;
	reach: Reach;
}>();
const emit = defineEmits<{
	expand: [];
	centre: [];
	hover: [id: string | null];
	select: [id: string];
	toggleKind: [kind: string];
	setProbable: [on: boolean];
	setReach: [reach: Reach];
}>();

const style = computed(() => (props.info ? KINDS[props.info.kind] : null));
const drawable = computed(() => !!props.info?.geometry && hasDrawableDims(props.info.geometry));
const dims = computed(() => sampleDims(props.info?.geometry));

const groups = computed(() => orderedGroups(props.connections));
const total = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));
/** A group shows this many entries until opened (a project can hold hundreds of samples). */
const SHOWN = 8;
const opened = ref<ReadonlySet<string>>(new Set());
const flip = (group: string) => {
	const next = new Set(opened.value);
	if (!next.delete(group)) next.add(group);
	opened.value = next;
};
const listed = <T,>(group: string, items: T[]): T[] => (opened.value.has(group) ? items : items.slice(0, SHOWN));

/** The kind of a connection's record, for its dot. */
const COLLECTION_KIND: Record<string, keyof typeof KINDS> = { physical_samples: 'sample', manufacturing_operations: 'operation', test_sessions: 'test', raw_stock_lots: 'stock_lot' };
const dot = (collection: string): string => {
	const k = COLLECTION_KIND[collection] ?? kindOfCollection(collection);
	return k ? kindVar(KINDS[k]) : 'var(--k-file)';
};

const chipLabel = (k: string) => (k === SETTINGS_CHIP ? 'Settings' : (KINDS[k as keyof typeof KINDS]?.label ?? k));
const chipColor = (k: string) => (k in KINDS ? kindVar(KINDS[k as keyof typeof KINDS]) : 'var(--d1-dim)');

const REACHES = [
	{ value: '1', label: '1' },
	{ value: '2', label: '2' },
	{ value: '3', label: '3' },
	{ value: 'all', label: 'Whole history' },
] as const;
const onReach = (v: string) => emit('setReach', v === 'all' ? 'all' : (Number(v) as Reach));
</script>

<template>
	<div class="pm-rail">
		<RecordRail
			v-if="info && style"
			:kind="style.label"
			:code="info.code"
			:plain="info.plain"
			:title="info.title"
			:facts="info.facts"
			:style="{ '--k': kindVar(style) }"
			class="pm-ident"
		>
			<template #kind-icon><v-icon :name="style.icon" x-small /></template>
			<template #status><StatusBadge :kind="statusKindOf(info.kind)" :value="info.status" /></template>
			<template #actions>
				<v-button small :to="recordRoute(info.ref.collection, info.ref.id)"><v-icon name="open_in_new" small left />Open record</v-button>
				<v-button v-if="onMap" small secondary @click="emit('expand')"><v-icon name="add" small left />Expand</v-button>
				<v-button v-if="onMap" small secondary @click="emit('centre')"><v-icon name="my_location" small left />Centre</v-button>
			</template>
			<template v-if="drawable || (preview && preview.kind !== 'none')" #extra>
				<SampleGeometry v-if="drawable" :dims="dims" aria-hidden="true" />
				<DataThumb :preview="preview" link />
			</template>
		</RecordRail>
		<div v-else class="pm-none">Select a record on the map to see it here.</div>

		<Section title="Connections" :count="total" class="pm-conn" :empty="!total" empty-text="Nothing else is connected in what is loaded.">
			<template v-for="g in groups" :key="g.group">
				<div class="rel">{{ g.group }}</div>
				<button
					v-for="c in listed(g.group, g.items)"
					:key="c.nodeId"
					type="button"
					class="conn"
					:class="{ hi: highlight?.has(c.nodeId) }"
					:style="{ '--k': dot(c.collection) }"
					@mouseenter="emit('hover', c.nodeId)"
					@mouseleave="emit('hover', null)"
					@click="emit('select', c.nodeId)"
				>
					<span class="dot" aria-hidden="true"></span>
					<span class="c">{{ c.code }}</span>
					<span v-if="c.label" class="d">{{ c.label }}</span>
				</button>
				<button v-if="g.items.length > SHOWN" type="button" class="more" :aria-expanded="opened.has(g.group)" @click="flip(g.group)">
					{{ opened.has(g.group) ? 'Show fewer' : `${g.items.length - SHOWN} more` }}
				</button>
			</template>
		</Section>

		<Section title="Show">
			<div class="chips">
				<button
					v-for="k in presentKinds"
					:key="k"
					type="button"
					class="chip"
					:class="{ off: hiddenKinds.has(k) }"
					:style="{ '--k': chipColor(k) }"
					:aria-pressed="!hiddenKinds.has(k)"
					@click="emit('toggleKind', k)"
				>
					<span class="dot" aria-hidden="true"></span>{{ chipLabel(k) }}
				</button>
				<button type="button" class="chip" :class="{ off: !probable }" style="--k: var(--k-op)" :aria-pressed="probable" @click="emit('setProbable', !probable)">
					<span class="dot" aria-hidden="true"></span>Probable batches
				</button>
			</div>
		</Section>

		<Section title="Reach">
			<div class="field">
				<span class="lab">Steps from the focus record</span>
				<SegmentedControl :model-value="String(reach)" :options="REACHES" label="Reach" @update:model-value="onReach" />
			</div>
		</Section>
	</div>
</template>

<style scoped>
.pm-rail { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.pm-ident :deep(.kind) {
	color: color-mix(in srgb, var(--k) 62%, var(--theme--foreground));
	background: color-mix(in srgb, var(--k) 14%, transparent);
}
.pm-ident :deep(.extra) { display: flex; flex-direction: column; gap: 8px; }
.pm-none { padding: 14px 16px; color: var(--d1-dim); font-size: var(--fs-md, 13px); border: 1px dashed var(--d1-line); border-radius: var(--d1-radius, 12px); }

.rel { margin: 10px 0 4px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.rel:first-child { margin-top: 0; }
.conn {
	display: flex; align-items: center; gap: 8px; width: calc(100% + 16px); margin: 0 -8px; padding: 5px 8px;
	border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.conn:hover, .conn:focus-visible, .conn.hi { background: var(--d1-tile); }
.conn.hi { box-shadow: inset 3px 0 0 var(--k); }
.conn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--k); }
.c { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 700; color: var(--d1-accent, var(--theme--primary)); }
.d { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.more { margin: 2px 0 0; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-sm, 12px); color: var(--d1-accent, var(--theme--primary)); cursor: pointer; }
.more:hover { text-decoration: underline; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
	display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-sm, 12px); cursor: pointer; user-select: none;
}
.chip:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.chip.off { opacity: 0.55; }
.chip.off .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--k); }

.field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.lab { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
