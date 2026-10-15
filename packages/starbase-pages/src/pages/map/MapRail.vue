<script setup lang="ts">
import { computed, ref } from 'vue';
import { AppLink, RecordRail, Section, SegmentedControl, StatusBadge, hasDrawableDims, mapPath, sampleDims } from '@d1/ui';
import SampleGeometry from '../sample/SampleGeometry.vue';
import DataThumb from './DataThumb.vue';
import { orderedGroups, type Connections } from './model/connections';
import type { DataPreview } from './model/dataPreview';
import { openPath, type RecordInfo } from './model/recordInfo';
import { focusPlan, kindOf } from './model/collections';
import { KINDS, kindVar, statusKindOf } from './nodes/kinds';
import { CARD_CAP, type Reach } from './model/reach';
import { SETTINGS_CHIP } from './model/showChips';

// The rail of the Process map (spec §6.5), from the top: the selected record's identity (kind, status,
// code, title), its actions (Open record, Process map of it, Expand, Centre), the sample drawing for a sample, the data
// thumbnail when it has data, its facts; then Connections (hover shows the hover card on the canvas,
// click selects and centres), Show (what the map draws) and Reach (how many steps). The page owns the
// state; this only draws it and reports what the person did.
const props = defineProps<{
	info: RecordInfo | null;
	/** The record the map is focused on (the URL's), so the rail does not offer a map of the map it is already showing. */
	focus?: { collection: string; id: string } | null;
	preview?: DataPreview;
	/** The selected record is a card on the map (Expand and Centre need one). */
	onMap: boolean;
	connections: Connections;
	/** Node ids to show highlighted in Connections (a hovered socket's wires touch them). */
	highlight?: ReadonlySet<string>;
	presentKinds: string[];
	hiddenKinds: ReadonlySet<string>;
	probable: boolean;
	/** The reach the person asked for. */
	reach: Reach;
	/** The reach actually drawn: fewer steps than `reach` when the card cap clamped it (spec D22). */
	drawnReach?: Reach;
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
/** Where Open record goes: the record's page, the Force dashboard for Force data, the file library for a file; none, no button. */
const openTo = computed(() => (props.info ? openPath(props.info) : null));
/** The selected record's own map (spec §8): offered when its collection opens one and it is not the focus already. */
const mapTo = computed(() => {
	const ref = props.info?.ref;
	if (!ref || !focusPlan(ref.collection)) return null;
	if (props.focus && props.focus.collection === ref.collection && props.focus.id === ref.id) return null;
	return mapPath(ref.collection, ref.id);
});
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
const dot = (collection: string): string => {
	const k = kindOf(collection);
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
const shownReach = computed(() => props.drawnReach ?? props.reach);
const clamp = computed(() => {
	if (shownReach.value === props.reach) return '';
	const asked = props.reach === 'all' ? 'the whole history' : `${props.reach} steps`;
	const n = shownReach.value;
	return `Showing ${n} ${n === 1 ? 'step' : 'steps'}: ${asked} would be more than ${CARD_CAP} cards.`;
});
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
				<v-button v-if="openTo" small :to="openTo"><v-icon name="open_in_new" small left />Open record</v-button>
				<AppLink v-if="mapTo" :to="mapTo" class="pm-maplink"><v-icon name="account_tree" small left />Process map of {{ info.code }}</AppLink>
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
				<SegmentedControl :model-value="String(shownReach)" :options="REACHES" label="Reach" @update:model-value="onReach" />
				<span v-if="clamp" class="clamp" role="status">{{ clamp }}</span>
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
.pm-maplink {
	display: inline-flex; align-items: center; box-sizing: border-box; min-height: 36px; padding: 0 12px; border-radius: var(--theme--border-radius, 6px);
	border: 2px solid var(--d1-line); background: var(--d1-surface); color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-sm, 12px); font-weight: 600; text-decoration: none; white-space: nowrap;
}
.pm-maplink:hover, .pm-maplink:focus-visible { background: var(--d1-tile); }
.pm-maplink:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
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
.clamp { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
