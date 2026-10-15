<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import { StatusBadge } from '@d1/ui';
import type { ContainerNode, SampleRow } from '../model/types';
import { isBundleSocket } from '../model/sockets';
import { activating, cardHandlers, stopping, useHiddenSides, useMapActions, useMapView, useSocketProps } from './actions';
import { edgeStyle, handlePosition } from './handle';
import { KINDS, kindVar, statusKindOf } from './kinds';
import HiddenPill from './HiddenPill.vue';
import SlotRow from './SlotRow.vue';

// An operation or a test as a container (spec D4, D5, D8, D9, D14): a tinted header, one sample row per
// sample with its sockets, the Inside tray, the key settings. Every socket id is drawn once: a shared
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
// A probable batch shows the method, not the first row's code (it would stand for the whole batch).
const showCode = computed(() => !!props.data.code && !props.data.probable && !props.data.title.includes(props.data.code));

interface RowView {
	row: SampleRow;
	/** Labels of the sides that show a sample on this row; null leaves that side blank. */
	inLabel: string | null;
	outLabel: string | null;
	in: string | null;
	out: string | null;
}
// Inputs and outputs are numbered apart: a cut has one input shared by every row and several outputs, and
// that input is labelled once (on the row that draws its socket), not repeated on every output's row.
const distinct = (sockets: (string | undefined)[]) => new Set(sockets.filter((s): s is string => !!s)).size;
const severalIn = computed(() => distinct(props.data.rows.map((r) => r.in)) > 1);
const severalOut = computed(() => distinct(props.data.rows.map((r) => r.out)) > 1);
const shown = computed<RowView[]>(() => {
	const seen = new Set<string>();
	const rows = props.data.bundled ? props.data.rows.slice(0, SHOWN_WHEN_FOLDED) : props.data.rows;
	let nIn = 0;
	let nOut = 0;
	return rows.map((row) => {
		const input = row.in && !isBundleSocket(row.in) && !seen.has(row.in) ? row.in : null;
		if (input) seen.add(input);
		const out = row.out && !isBundleSocket(row.out) && !seen.has(row.out) ? row.out : null;
		if (out) seen.add(out);
		const inLabel = input ? (severalIn.value ? `Sample ${++nIn}` : 'Sample') : null;
		const outLabel = row.out ? (severalOut.value ? `Sample ${++nOut}` : 'Sample') : null;
		return { row, inLabel, outLabel, in: input, out };
	});
});
const hidden = computed(() => (props.data.bundled ? props.data.rows.slice(SHOWN_WHEN_FOLDED) : []));
const bundleIn = computed(() => hidden.value.find((r) => r.in && isBundleSocket(r.in))?.in ?? null);
const bundleOut = computed(() => hidden.value.find((r) => r.out && isBundleSocket(r.out))?.out ?? null);
const canFold = computed(() => !props.data.bundled && props.data.rows.length > FOLD_ABOVE);

const collapsedIn = computed(() => (props.data.collapsed ? (props.data.rows[0]?.in ?? null) : null));
const majors = computed(() => props.data.slots.filter((s) => s.major));
const minors = computed(() => props.data.slots.filter((s) => !s.major));
const open = computed(() => moreOpen.value.has(props.id));
const moreText = computed(() => (open.value ? 'Show fewer' : `+${minors.value.length} more from the form`));

const card = cardHandlers(actions, () => props.id);
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
		:class="{ test: data.kind === 'test', probable: data.probable, dashed: data.probable, collapsed: data.collapsed, focal: selected }"
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
			<span class="m">{{ data.title }}</span>
			<span v-if="showCode" class="c">{{ data.code }}</span>
			<span v-if="data.collapsed && data.meta" class="c">{{ data.meta }}</span>
			<StatusBadge class="st" :kind="statusKindOf(data.kind)" :value="data.status" />
			<button class="xbtn nodrag nopan" type="button" aria-label="Expand" @click="card.expand"><v-icon name="add" x-small /></button>
		</div>

		<div v-if="data.rows.length && !data.collapsed" class="iorows">
			<div v-for="(r, i) in shown" :key="i" class="orow">
				<span>
					<Handle v-if="r.in" :id="r.in" class="sock row in" type="target" :position="inPos" :connectable="false" v-bind="sockProps(r.in, 'in')" />
					<template v-if="r.inLabel">{{ r.inLabel }}</template>
				</span>
				<span :class="{ pass: r.row.inPlace }"></span>
				<span>
					<template v-if="r.outLabel">{{ r.outLabel }}</template>
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
		</div>

		<div v-if="data.slots.length && !data.collapsed" class="slots" @click.stop>
			<div class="lab">Inside</div>
			<SlotRow v-for="s in majors" :key="s.field" :item="s" />
			<template v-if="open">
				<SlotRow v-for="s in minors" :key="s.field" :item="s" minor />
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
.collapsed .ohead { border-radius: 11px; border-bottom: 0; }
.m { font-weight: 700; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.c { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.st { margin-left: auto; }
.st + .xbtn { margin-left: 6px; }
.m + .xbtn, .c + .xbtn { margin-left: auto; }

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
.lab { font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--d1-dim); padding: 2px 4px 0; }
.more-toggle { text-align: center; padding: 5px 8px; border-radius: 8px; border: 1px dashed var(--d1-line); color: var(--d1-dim); font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; }
.more-toggle:hover { color: var(--theme--foreground); }
.orow:focus-visible, .more-toggle:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }

.params { margin: 0; padding: 8px 14px 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; font-size: var(--fs-sm, 12px); }
.params div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--d1-line); padding: 2px 0; }
.params dt { color: var(--d1-dim); }
.params dd { margin: 0; font-weight: 600; }
</style>
