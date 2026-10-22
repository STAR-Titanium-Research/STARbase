<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import { StatusBadge, processLabel } from '@d1/ui';
import { rowRecordId, type EndSide, type SocketRef } from '../edit/socketRefs';
import type { ContainerNode } from '../model/types';
import { railSockets, socketOwners, SHOWN_WHEN_FOLDED, type RailSocketModel } from '../model/railSockets';
import { isBundleSocket } from '../model/sockets';
import { activating, cardHandlers, editSocketProps, freeSocketLabel, stopping, useExpanded, useHiddenSides, useMapActions, useMapEdit, useMapView, useSelected, useSocketBinder } from './actions';
import { edgeStyle, handlePosition } from './handle';
import { KINDS, kindVar, statusKindOf } from './kinds';
import HiddenPill from './HiddenPill.vue';
import SlotRow from './SlotRow.vue';

// An operation or a test as a container (spec D4, D5, D8, D9, D14): a tinted title bar saying what kind of
// step it is ("Machining | Turning"), the step's own name and date, a socket rail, the Inside tray, the key
// settings. A stack of passes is drawn as a deck of cards, with "Unstack" on its rail (a double-click on it does the same, and on a pass of an unstacked stack stacks them again). The rail is one line of
// text ("1 sample → 4 pieces") with the input sockets stacked on its left edge and the output sockets on its
// right: no per-row labels, since the wires and the sample cards already say which sample is which. Every
// socket id is drawn once (a cut's shared input once; the folded rows' bundle sockets last, fat). Folding is
// the model's (`bundled`, rows from index 2 on share `:b` sockets); the rail's "+N more" / "fold" asks the
// page through `toggleRows`.
const props = defineProps<{ id: string; data: ContainerNode }>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();
const { direction, moreOpen } = useMapView();
const selected = useSelected(() => props.id);

/** More rows than this fold by default; an unfolded container with more offers "fold". */
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

/** Vertical distance between two sockets of a rail stack, and the rail's padding above and below it. */
const PITCH = 16;
const RAIL_PAD = 8;

/** A rail socket (model/railSockets) with where it sits on the rail. */
type RailSocket = RailSocketModel & { top: string };

const hidden = computed(() => (props.data.bundled ? props.data.rows.slice(SHOWN_WHEN_FOLDED) : []));
const canFold = computed(() => !props.data.bundled && props.data.rows.length > FOLD_ABOVE);

// Edit mode (spec E8, E9): the sockets of a new container are where wires start and end. A socket with a wire is a Handle already; a
// side with nothing wired has none drawn, so edit mode draws a free one, a button, on the rail in its place (a blank operation is
// one row with a free input). Which row a socket is comes from the model (model/railSockets), not from the rail.
const edit = useMapEdit();
const editable = computed(() => !!edit?.editing.value && !!(props.data.draft || props.data.attaching) && !props.data.collapsed);
/** The edit controls of one row's `side`: where a wire starts or ends on the draft. */
const rowRef = (recordId: string, side: EndSide): SocketRef => ({ kind: 'row', id: rowRecordId(props.data, recordId, side), side });
const owners = computed(() => socketOwners(props.data));
/** The edit controls of a rail socket drawn as a Handle (null where nobody can build from it: folded bundles, a test's output). */
const railRef = (socket: string, side: EndSide): SocketRef | null => {
	const owner = editable.value ? owners.value.get(socket) : undefined;
	return owner && owner.side === side ? rowRef(owner.recordId, side) : null;
};
const freeProps = (recordId: string | null, side: EndSide, add?: true) => (edit && editable.value && recordId !== null ? editSocketProps(edit, { ...rowRef(recordId, side), ...(add ? { add } : {}) }) : {});
const what = computed(() => props.data.code || props.data.title);
const badge = computed(() => (edit?.editing.value ? edit.badge(props.data) : null));
/** Why the selected card cannot be removed (a done record), shown with a lock: "Done records can't be removed from the map". */
const lock = computed(() => (selected.value && edit?.editing.value ? edit.lockOf(props.data) : null));
/** Planned or done at Create (R9): a new operation or test wears a chip that says which, and flips it. */
const work = computed(() => (edit?.editing.value ? (edit.work?.(props.data) ?? null) : null));
const flip = stopping(() => work.value?.toggle());

// The two stacks are centred on each other, so a cut's one input sits level with the middle of its pieces
// and rows in place (same count each side) line up straight across.
const wired = computed(() => (editable.value ? edit?.wiredSockets(props.data) : undefined));
const rail = computed(() => {
	const ins = railSockets(props.data, 'in', { editable: editable.value, selected: selected.value, wired: wired.value });
	const outs = railSockets(props.data, 'out', { editable: editable.value, selected: selected.value, wired: wired.value });
	// The rail is as tall as it gets while the card is selected (the free sockets are there), so selecting a card never changes its size.
	const most = (side: 'in' | 'out') => railSockets(props.data, side, { editable: editable.value, selected: true, wired: wired.value }).length;
	const tall = Math.max(ins.length, outs.length, most('in'), most('out'), 1);
	const place = (list: RailSocketModel[]): RailSocket[] =>
		list.map((s, i) => ({ ...s, top: `${RAIL_PAD + PITCH / 2 + ((tall - list.length) / 2 + i) * PITCH}px` }));
	return { ins: place(ins), outs: place(outs), height: `${RAIL_PAD * 2 + tall * PITCH}px` };
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** What goes in and what comes out, counted over every row (folded ones too). */
const summary = computed(() => {
	const rows = props.data.rows;
	const inPlace = rows.filter((r) => r.inPlace).length;
	const made = rows.filter((r) => r.out && !r.inPlace).length;
	const ins = rows.filter((r) => r.in);
	const bundledIn = ins.some((r) => isBundleSocket(r.in!));
	const nIn = bundledIn ? ins.length : new Set(ins.map((r) => r.in)).size;
	if (props.data.kind === 'test') return `${plural(rows.length, 'sample')} tested`;
	if (props.data.stacked) return `1 sample · ${props.data.group.rowIds.length} passes`;
	if (made === 0 && inPlace === 0) return plural(nIn, 'sample');
	if (inPlace === rows.length) return `${plural(rows.length, 'sample')} · in place`;
	if (nIn === 0) return `Makes ${plural(made, 'sample')}`;
	if (nIn === 1) return `1 sample → ${plural(made, 'piece')}`;
	return `${plural(nIn, 'sample')} → ${plural(made + inPlace, 'sample')}`;
});
const railToggle = computed(() => (hidden.value.length ? `+${hidden.value.length} more` : canFold.value ? 'fold' : null));

const collapsedIn = computed(() => (props.data.collapsed ? (props.data.rows[0]?.in ?? null) : null));
const majors = computed(() => props.data.slots.filter((s) => s.major));
const minors = computed(() => props.data.slots.filter((s) => !s.major));
const moreShown = computed(() => moreOpen.value.has(props.id));
const moreText = computed(() => (moreShown.value ? 'Show fewer' : `+${minors.value.length} more from the form`));

const card = cardHandlers(actions, () => props.id, () => open.value, () => (props.data.stacked ? 'unstack' : props.data.unstackedPass ? 'restack' : null));
const unstack = stopping(() => actions.unstack?.(props.id));
const unstackKey = activating(() => actions.unstack?.(props.id));
const sockProps = useSocketBinder();
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
		:class="{ test: data.kind === 'test', probable: data.probable, dashed: data.probable, collapsed: data.collapsed, stacked: data.stacked, planned: data.planned, draft: data.draft, removing: data.removing, focal: selected }"
		:style="{ '--k': kindVar(style), '--sk': 'var(--k-sample)' }"
		@click="card.select"
		@dblclick="card.dblclick"
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
			<span v-if="data.attaching && edit?.editing.value" class="apill" title="A recorded operation: Create gives it the sample wired to its input, and writes any edits you make to it in the side panel. The database then renumbers and re-codes it and updates who may read it, and adds the lineage.">Attach</span>
			<span v-if="data.stacked" class="deck" :title="`${data.group.rowIds.length} passes stacked`">×{{ data.group.rowIds.length }}</span>
			<button v-if="work" type="button" class="wchip nodrag nopan" :class="work.state" :aria-label="work.label" :title="work.label" :data-work="work.state" @click="flip" @keydown.stop>{{ work.state === 'done' ? 'Done' : 'Planned' }}</button>
			<span v-if="lock" class="lock" role="img" :aria-label="lock" :title="lock"><v-icon name="lock" x-small /></span>
			<span v-if="badge" class="chk" :class="{ warn: badge.level === 'warn' }" role="img" :aria-label="badge.text" :title="badge.text">{{ badge.count }}</span>
			<button v-if="!data.draft" class="xbtn nodrag nopan" :class="{ quiet: !open }" type="button" :aria-label="open ? 'Collapse' : 'Expand'" @click="card.expand"><v-icon :name="open ? 'remove' : 'add'" x-small /></button>
		</div>
		<div class="oname">
			<div class="nl">
				<span class="n" :class="{ code: name === data.code }">{{ name }}</span>
				<StatusBadge class="st" :kind="statusKindOf(data.kind)" :value="data.status" />
			</div>
			<span v-if="data.when || (data.collapsed && data.meta)" class="d">{{ data.when ?? data.meta }}</span>
			<span v-if="lock" class="why" role="note">{{ lock }}</span>
		</div>

		<div v-if="data.rows.length && !data.collapsed" class="rail" :style="{ minHeight: rail.height }">
			<template v-for="s in rail.ins" :key="s.id">
				<button
					v-if="s.free"
					type="button"
					class="sock rail-sock in free nodrag nopan"
					:style="{ top: s.top }"
					:aria-label="freeSocketLabel('in', what)"
					v-bind="freeProps(s.recordId, 'in', s.add)"
				></button>
				<Handle
					v-else
					:id="s.id"
					class="sock rail-sock in"
					:class="{ fat: s.fat }"
					type="target"
					:position="inPos"
					:connectable="false"
					:style="{ top: s.top }"
					v-bind="sockProps(s.id, 'in', railRef(s.id, 'in'))"
				/>
			</template>
			<span class="sum">{{ summary }}</span>
			<button v-if="railToggle" class="rtoggle nodrag nopan" type="button" @click="refold" @keydown="refoldKey">{{ railToggle }}</button>
			<button v-if="data.stacked" class="rtoggle nodrag nopan" type="button" :aria-label="`Unstack ${data.group.rowIds.length} passes`" title="Unstack (or double-click the stack)" @click="unstack" @keydown="unstackKey">Unstack</button>
			<template v-for="s in rail.outs" :key="s.id">
				<button
					v-if="s.free"
					type="button"
					class="sock rail-sock out free nodrag nopan"
					:style="{ top: s.top }"
					:aria-label="freeSocketLabel('out', what)"
					v-bind="freeProps(s.recordId, 'out', s.add)"
				></button>
				<Handle
					v-else
					:id="s.id"
					class="sock rail-sock out"
					:class="{ fat: s.fat }"
					type="source"
					:position="outPos"
					:connectable="false"
					:style="{ top: s.top }"
					v-bind="sockProps(s.id, 'out', railRef(s.id, 'out'))"
				/>
			</template>
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
.op { width: 264px; }
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
.apill { font-size: var(--fs-xs, 11px); font-weight: 700; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--d1-accent, var(--theme--primary)); color: var(--d1-accent, var(--theme--primary)); }
.m + .xbtn, .deck + .xbtn, .apill + .xbtn { margin-left: auto; }
.m + .chk { margin-left: auto; }

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

.rail { position: relative; display: flex; align-items: center; gap: 8px; padding: 0 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rtoggle { flex: none; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--d1-line); background: none; font: inherit; font-weight: 600; color: color-mix(in srgb, var(--k-sample) 62%, var(--theme--foreground)); cursor: pointer; }
.rtoggle:hover { background: var(--d1-tint); }
.rtoggle:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }

.slots { margin: 0 10px 10px; padding: 6px; border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); display: flex; flex-direction: column; gap: 4px; cursor: default; }
.slots:has(+ .params) { margin-bottom: 0; }
.more-toggle { text-align: center; padding: 5px 8px; border-radius: 8px; border: 1px dashed var(--d1-line); color: var(--d1-dim); font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; }
.more-toggle:hover { color: var(--theme--foreground); }
.more-toggle:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }

.params { margin: 0; padding: 8px 14px 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; font-size: var(--fs-sm, 12px); }
.params div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--d1-line); padding: 2px 0; }
.params dt { color: var(--d1-dim); }
.params dd { margin: 0; font-weight: 600; }
</style>
