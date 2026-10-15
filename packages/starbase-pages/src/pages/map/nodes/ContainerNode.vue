<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import { StatusBadge, processLabel } from '@d1/ui';
import type { ContainerNode, SampleRow } from '../model/types';
import { isBundleSocket } from '../model/sockets';
import { activating, cardHandlers, stopping, useExpanded, useHiddenSides, useMapActions, useMapView, useSocketProps } from './actions';
import { edgeStyle, handlePosition } from './handle';
import { KINDS, kindVar, statusKindOf } from './kinds';
import HiddenPill from './HiddenPill.vue';
import SlotRow from './SlotRow.vue';

// An operation or a test as a container (spec D4, D5, D8, D9, D14): a tinted title bar saying what kind of
// step it is ("Machining | Turning"), the step's own name and date, one sample row per sample with its
// sockets, the Inside tray, the key settings. A stack of passes is drawn as a deck of cards with "Unstack".
// Every socket id is drawn once: a shared
// input (a cut) on the first row that has it, the folded rows' bundle sockets on the "+N more samples"
// row. Folding is the model's (`bundled`, rows from index 2 on share `:b` sockets); the bundle row and
// the "Fold samples" row ask the page to refold through `toggleRows`.
const props = defineProps<{ id: string; data: ContainerNode; selected?: boolean }>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();
const { direction, moreOpen } = useMapView();

/** Rows drawn on their own sockets when a container is folded. */
const SHOWN_WHEN_FOLDED = 2;
/** More rows than this fold by default; an unfolded container with more offers "Fold samples". */
const FOLD_ABOVE = 3;

const style = computed(() => KINDS[props.data.kind]);
/** The title bar: the process, then the method ("Machining | Turning"); a test, "Test | Tensile". */
const kindLine = computed(() => {
	const d = props.data;
	const process = d.kind === 'test' ? 'Test' : processLabel(d.category === 'test' ? null : d.category);
	const method = d.method ?? (d.kind === 'test' ? '' : d.title);
	return method && method.toLowerCase() !== process.toLowerCase() ? `${process} | ${method}` : process;
});
/**
 * The step's own name in the card: its code (the full operation name) for a single row; a batch or a stack says
 * what it is ("Batch B-0003", "Probable batch · Wire cut", "6 passes"), never the first row's code, which would
 * stand for all of them.
 */
const name = computed(() => {
	const d = props.data;
	if (d.probable || d.stacked || d.group.batch) return d.title;
	return d.code || d.title;
});
const open = useExpanded(() => props.id);

interface RowView {
	row: SampleRow;
	label: string;
	in: string | null;
	out: string | null;
}
const several = computed(() => props.data.rows.length > 1);
const shown = computed<RowView[]>(() => {
	const seen = new Set<string>();
	const rows = props.data.bundled ? props.data.rows.slice(0, SHOWN_WHEN_FOLDED) : props.data.rows;
	return rows.map((row, i) => {
		const input = row.in && !isBundleSocket(row.in) && !seen.has(row.in) ? row.in : null;
		if (input) seen.add(input);
		const out = row.out && !isBundleSocket(row.out) && !seen.has(row.out) ? row.out : null;
		if (out) seen.add(out);
		return { row, label: several.value ? `Sample ${i + 1}` : 'Sample', in: input, out };
	});
});
const hidden = computed(() => (props.data.bundled ? props.data.rows.slice(SHOWN_WHEN_FOLDED) : []));
const bundleIn = computed(() => hidden.value.find((r) => r.in && isBundleSocket(r.in))?.in ?? null);
const bundleOut = computed(() => hidden.value.find((r) => r.out && isBundleSocket(r.out))?.out ?? null);
const canFold = computed(() => !props.data.bundled && props.data.rows.length > FOLD_ABOVE);

const collapsedIn = computed(() => (props.data.collapsed ? (props.data.rows[0]?.in ?? null) : null));
const majors = computed(() => props.data.slots.filter((s) => s.major));
const minors = computed(() => props.data.slots.filter((s) => !s.major));
const moreShown = computed(() => moreOpen.value.has(props.id));
const moreText = computed(() => (moreShown.value ? 'Show fewer' : `+${minors.value.length} more from the form`));

const card = cardHandlers(actions, () => props.id, () => open.value);
const unstack = stopping(() => actions.unstack?.(props.id));
const unstackKey = activating(() => actions.unstack?.(props.id));
const sockProps = useSocketProps();
const hiddenSides = useHiddenSides(() => props.id);
const refold = stopping(() => actions.toggleRows(props.id));
const toggleMore = stopping(() => actions.toggleMore(props.id));
const refoldKey = activating(() => actions.toggleRows(props.id));
const toggleMoreKey = activating(() => actions.toggleMore(props.id));
const inPos = computed(() => handlePosition(direction.value, 'in'));
const outPos = computed(() => handlePosition(direction.value, 'out'));
</script>

<template>
	<div
		class="node op"
		:class="{ test: data.kind === 'test', probable: data.probable, dashed: data.probable, collapsed: data.collapsed, stacked: data.stacked, focal: selected }"
		:style="{ '--k': kindVar(style), '--sk': 'var(--k-sample)' }"
		@click="card.select"
		@mouseenter="card.enter"
		@mouseleave="card.leave"
	>
		<HiddenPill v-for="side in hiddenSides" :key="side" :side="side" />
		<!-- A collapsed container (a used-in fan item) is its header and one input socket: its samples load on ＋. -->
		<Handle
			v-if="data.collapsed && collapsedIn"
			:id="collapsedIn"
			class="sock"
			type="target"
			:position="inPos"
			:connectable="false"
			:style="edgeStyle(direction, 'in', 0, 1)"
			v-bind="sockProps(collapsedIn, 'in')"
		/>
		<div class="ohead">
			<v-icon class="k-ink" :name="style.icon" small />
			<span class="m">{{ kindLine }}</span>
			<span v-if="data.stacked" class="deck" :title="`${data.group.rowIds.length} passes stacked`">×{{ data.group.rowIds.length }}</span>
			<button class="xbtn nodrag nopan" type="button" :aria-label="open ? 'Collapse' : 'Expand'" @click="card.expand"><v-icon :name="open ? 'remove' : 'add'" x-small /></button>
		</div>
		<div class="oname">
			<div class="nl">
				<span class="n" :class="{ code: name === data.code }">{{ name }}</span>
				<StatusBadge class="st" :kind="statusKindOf(data.kind)" :value="data.status" />
			</div>
			<span v-if="data.when || (data.collapsed && data.meta)" class="d">{{ data.when ?? data.meta }}</span>
		</div>

		<div v-if="data.rows.length && !data.collapsed" class="iorows">
			<div v-for="(r, i) in shown" :key="i" class="orow">
				<span>
					<Handle v-if="r.in" :id="r.in" class="sock row in" type="target" :position="inPos" :connectable="false" v-bind="sockProps(r.in, 'in')" />
					<template v-if="r.row.in">{{ r.label }}</template>
				</span>
				<span :class="{ pass: r.row.inPlace }"></span>
				<span>
					<template v-if="r.row.out">{{ r.label }}</template>
					<Handle v-if="r.out" :id="r.out" class="sock row out" type="source" :position="outPos" :connectable="false" v-bind="sockProps(r.out, 'out')" />
				</span>
			</div>
			<div v-if="hidden.length" class="orow bundle nodrag nopan" role="button" tabindex="0" @click="refold" @keydown="refoldKey">
				<span>
					<Handle v-if="bundleIn" :id="bundleIn" class="sock row in fat" type="target" :position="inPos" :connectable="false" v-bind="sockProps(bundleIn, 'in')" />
					{{ `+${hidden.length} more samples` }}
				</span>
				<span></span>
				<span>
					<Handle v-if="bundleOut" :id="bundleOut" class="sock row out fat" type="source" :position="outPos" :connectable="false" v-bind="sockProps(bundleOut, 'out')" />
				</span>
			</div>
			<div v-if="canFold" class="orow fold nodrag nopan" role="button" tabindex="0" @click="refold" @keydown="refoldKey">
				<span></span><span>Fold samples</span><span></span>
			</div>
			<div v-if="data.stacked" class="orow fold nodrag nopan" role="button" tabindex="0" @click="unstack" @keydown="unstackKey">
				<span></span><span>{{ `Unstack ${data.group.rowIds.length} passes` }}</span><span></span>
			</div>
		</div>

		<div v-if="data.slots.length && !data.collapsed" class="slots" @click.stop>
			<SlotRow v-for="s in majors" :key="s.field" :item="s" />
			<template v-if="moreShown">
				<SlotRow v-for="s in minors" :key="s.field" :item="s" />
			</template>
			<div v-if="minors.length" class="slot more-toggle nodrag nopan" role="button" tabindex="0" @click="toggleMore" @keydown="toggleMoreKey">
				{{ moreText }}
			</div>
		</div>

		<dl v-if="data.settings.length && !data.collapsed" class="params">
			<div v-for="s in data.settings" :key="s.label">
				<dt>{{ s.label }}</dt>
				<dd>{{ s.value }}</dd>
			</div>
		</dl>
	</div>
</template>

<style scoped>
.op { width: 310px; }
.ohead {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	white-space: nowrap;
	border-radius: 11px 11px 0 0;
	background: color-mix(in srgb, var(--k) 16%, var(--d1-surface));
	border-bottom: 1px solid color-mix(in srgb, var(--k) 30%, var(--d1-line));
}
.m { font-weight: 700; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.deck { font-size: var(--fs-xs, 11px); font-weight: 700; padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--k) 22%, var(--d1-surface)); font-variant-numeric: tabular-nums; }
.m + .xbtn, .deck + .xbtn { margin-left: auto; }

/* The step's own name: the full operation code wraps rather than running out of the card. */
.oname { display: flex; flex-direction: column; gap: 1px; padding: 8px 14px 2px; }
.nl { display: flex; align-items: flex-start; gap: 8px; }
.nl .st { margin-left: auto; flex: none; }
.n { font-weight: 700; overflow-wrap: anywhere; min-width: 0; }
.n.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); }
.oname .d { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.collapsed .oname { padding-bottom: 10px; }

/* A stack of passes: two cards' edges behind this one. */
.op.stacked { box-shadow: 5px 5px 0 -1px var(--d1-surface), 5px 5px 0 0 var(--d1-line), 10px 10px 0 -1px var(--d1-surface), 10px 10px 0 0 var(--d1-line), var(--d1-shadow); }
.op.stacked:hover { box-shadow: 5px 5px 0 -1px var(--d1-surface), 5px 5px 0 0 var(--d1-accent, var(--theme--primary)), 10px 10px 0 -1px var(--d1-surface), 10px 10px 0 0 var(--d1-line), var(--d1-shadow-lg, var(--d1-shadow)); }

.iorows { padding: 6px 0 8px; }
.orow { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; padding: 3px 14px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); min-height: 24px; }
.orow > span { position: relative; }
/* A sample passing straight through (in place): a faint line from its in socket to its out socket. */
.pass { height: 0; border-top: 1px dashed color-mix(in srgb, var(--k-sample) 45%, transparent); }
.orow.bundle, .orow.fold { cursor: pointer; font-weight: 600; color: color-mix(in srgb, var(--k-sample) 62%, var(--theme--foreground)); }
.orow.bundle:hover, .orow.fold:hover { background: var(--d1-tint); }
.orow.fold { grid-template-columns: 1fr auto 1fr; font-weight: 500; color: var(--d1-dim); }

.slots { margin: 0 10px 10px; padding: 6px; border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); display: flex; flex-direction: column; gap: 4px; cursor: default; }
.slots:has(+ .params) { margin-bottom: 0; }
.more-toggle { text-align: center; padding: 5px 8px; border-radius: 8px; border: 1px dashed var(--d1-line); color: var(--d1-dim); font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; }
.more-toggle:hover { color: var(--theme--foreground); }
.orow:focus-visible, .more-toggle:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }

.params { margin: 0; padding: 8px 14px 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; font-size: var(--fs-sm, 12px); }
.params div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--d1-line); padding: 2px 0; }
.params dt { color: var(--d1-dim); }
.params dd { margin: 0; font-weight: 600; }
</style>
