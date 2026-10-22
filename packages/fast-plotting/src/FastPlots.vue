<script setup lang="ts">
/*
 * Column 3, the Plots group: up to six tiles on a 2-wide grid that fills the height. Every tile shares one
 * time axis and one hover cursor. A tile is titled by what it shows with its peak, and can pick its series
 * (button or right-click), normalise, resize and be removed.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import FastChart from './FastChart.vue';
import FastSeriesMenu from './FastSeriesMenu.vue';
import { hasNoTileBelow, placeTiles, type TileSpan } from './chartMath';
import type { SeriesMeta, Trace } from './fastCache';
import { MAX_TILES, tilePeak, tileTitle, type Tile } from './fastTiles';
import type { RunWindowBand } from './profile';

const props = defineProps<{
	trace: Trace | null; catalog: SeriesMeta[]; message: string;
	zoomStart: number | null; zoomEnd: number | null; cursor: number | null;
	stacked: boolean;
	bands?: RunWindowBand[]; startMs?: number | null;   // Conform only: the run windows on the log, and the clock origin of the hover
	xTitle?: string;   // the time axis title when the profile words it (Conform); FAST keeps "Time (min)"
}>();
const emit = defineEmits<{ (e: 'zoom', v: { start: number; end: number } | null): void; (e: 'hover', t: number | null): void }>();
const tiles = defineModel<Tile[]>('tiles', { required: true });
const zoomTool = defineModel<boolean>('zoomTool', { required: true });

const SPANS: TileSpan[] = ['sm', 'wide', 'tall', 'big'];
const SPAN_NAMES: Record<TileSpan, string> = { sm: 'small', wide: 'wide', tall: 'tall', big: 'big' };
const nextSpan = (s: TileSpan) => SPANS[(SPANS.indexOf(s) + 1) % SPANS.length];
const zoomed = computed(() => props.zoomStart != null || props.zoomEnd != null);
const mins = (s: number) => +(s / 60).toFixed(1);
const zoomText = computed(() => `${mins(props.zoomStart ?? props.trace?.time[0] ?? 0)}–${mins(props.zoomEnd ?? props.trace?.time[props.trace.n - 1] ?? 0)} min`);

function update(id: number, patch: Partial<Tile>) { tiles.value = tiles.value.map((t) => (t.id === id ? { ...t, ...patch } : t)); }
let seq = 0;
function addTile() {
	if (tiles.value.length >= MAX_TILES) return;
	seq = Math.max(seq, ...tiles.value.map((t) => t.id)) + 1;
	tiles.value = [...tiles.value, { id: seq, series: [], span: 'sm', normalise: false }];
}
function toggleSeries(t: Tile, key: string) {
	update(t.id, { series: t.series.includes(key) ? t.series.filter((k) => k !== key) : [...t.series, key] });
}

// what each tile draws, with its title and peak
const drawn = computed(() => tiles.value.map((t) => {
	const tr = props.trace;
	const series = tr ? t.series.filter((k) => tr.series[k]).map((k) => { const s = tr.series[k]; return { key: k, label: s.label, unit: s.unit, group: s.group, values: s.values }; }) : [];
	return { tile: t, series, title: tileTitle(series), peak: tilePeak(series) };
}));

// ---- grid: columns by width; rows share the height, each clamped between 150 and 420px
const GAP = 12;
const gridEl = ref<HTMLElement | null>(null);
const box = ref({ w: 1000, h: 700 });
// the grid only exists once there is a trace, so the observer follows the element
const ro = new ResizeObserver(([e]) => { box.value = { w: e.contentRect.width, h: e.contentRect.height }; });
watch(gridEl, (el, old) => { if (old) ro.unobserve(old); if (el) ro.observe(el); });
onBeforeUnmount(() => ro.disconnect());
const cols = computed(() => (box.value.w < 480 ? 1 : box.value.w >= 1300 ? 3 : 2));
const layout = computed(() => placeTiles(tiles.value.map((t) => t.span), cols.value));
const rowH = computed(() => (props.stacked ? 260 : Math.min(420, Math.max(150, Math.floor((box.value.h - GAP * (layout.value.rows - 1)) / Math.max(1, layout.value.rows))))));
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${cols.value}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.max(1, layout.value.rows)}, ${rowH.value}px)` }));
const place = (i: number) => {
	const p = layout.value.placements[i];
	return { gridColumn: `${p.col + 1} / span ${p.colSpan}`, gridRow: `${p.row + 1} / span ${p.rowSpan}` };
};
// the time labels and title go on every tile with no tile below it (every tile when stacked)
const labelled = computed(() => hasNoTileBelow(layout.value.placements));
const bottom = (i: number) => props.stacked || labelled.value[i];
// the run-window labels go on the top row of tiles only (stacked: the first tile)
const topRow = (i: number) => (props.stacked ? i === 0 : layout.value.placements[i].row === 0);

// ---- series picker
const menu = ref<{ tile: number; x: number; y: number } | null>(null);
let opener: HTMLElement | null = null;
function openMenu(ev: MouseEvent, t: Tile) {
	ev.preventDefault();
	if (!props.catalog.length) return;
	// opened by the keyboard (detail 0) the menu sits under its button; otherwise at the pointer
	const button = ev.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
	opener = button;
	const at = ev.detail === 0 && button ? { x: button.getBoundingClientRect().left, y: button.getBoundingClientRect().bottom + 4 } : { x: ev.clientX, y: ev.clientY };
	// kept on screen, however narrow the viewport
	const x = Math.max(8, Math.min(at.x, window.innerWidth - 268));
	const y = Math.max(8, Math.min(at.y, window.innerHeight - Math.min(420, window.innerHeight * 0.6) - 8));
	menu.value = { tile: t.id, x, y };
}
const menuTile = computed(() => tiles.value.find((t) => t.id === menu.value?.tile) ?? null);
// Escape gives the focus back to the button that opened the picker; a click elsewhere keeps what it focused
function close(refocus = false) {
	menu.value = null;
	if (refocus) nextTick(() => opener?.focus());
}
const away = () => close();
const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && menu.value) close(true); };
onMounted(() => { window.addEventListener('click', away); window.addEventListener('keydown', esc); });
onBeforeUnmount(() => { window.removeEventListener('click', away); window.removeEventListener('keydown', esc); });
</script>

<template>
	<section class="fd-panel plots" aria-label="Plots">
		<header class="fd-lid">
			<v-icon name="show_chart" small /><span>Plots</span><span class="fd-chip" :title="`${tiles.length} of ${MAX_TILES} plots`">{{ tiles.length }} of {{ MAX_TILES }}</span>
			<button v-if="zoomed" class="fd-btn chip" title="Back to the whole run" @click="emit('zoom', null)">{{ zoomText }} <v-icon name="close" x-small /></button>
			<span class="grow"></span>
			<button class="fd-btn icon" :class="{ on: zoomTool }" :aria-pressed="zoomTool" title="Rectangle zoom: drag a box on any plot" :disabled="!trace" @click="zoomTool = !zoomTool"><v-icon name="crop_free" x-small /></button>
			<button class="fd-btn" :disabled="!zoomed" title="Reset zoom on all plots" @click="emit('zoom', null)"><v-icon name="restart_alt" x-small /> Reset zoom</button>
			<button class="fd-btn" :disabled="tiles.length >= MAX_TILES || !trace" @click="addTile"><v-icon name="add" x-small /> Add plot</button>
		</header>
		<div v-if="!trace" class="fd-empty">{{ message }}</div>
		<div v-else ref="gridEl" class="grid" :class="{ stacked }" :style="gridStyle">
			<article v-for="(d, i) in drawn" :key="d.tile.id" class="tile fd-panel" :style="place(i)" @contextmenu="openMenu($event, d.tile)">
				<header class="fd-lid thead">
					<span v-if="d.title" class="ttl">{{ d.title }}</span><span v-else class="ttl fd-dim">Pick series</span>
					<span v-if="d.peak" class="fd-dim peak">peak <b>{{ d.peak.value }} {{ d.peak.unit }}</b></span>
					<span class="grow"></span>
					<button class="fd-ib" title="Pick series (also right-click the tile)" aria-label="Pick series" @click.stop="openMenu($event, d.tile)"><v-icon name="playlist_add_check" x-small /></button>
					<button class="fd-ib" :class="{ on: d.tile.normalise }" :aria-pressed="d.tile.normalise" title="Normalise each series to its own range" aria-label="Normalise" @click.stop="update(d.tile.id, { normalise: !d.tile.normalise })">≈</button>
					<button class="fd-ib" :title="`Size: ${SPAN_NAMES[d.tile.span]}. Click for ${SPAN_NAMES[nextSpan(d.tile.span)]}`" aria-label="Resize" @click.stop="update(d.tile.id, { span: nextSpan(d.tile.span) })"><v-icon name="aspect_ratio" x-small /></button>
					<button class="fd-ib" title="Remove this plot" aria-label="Remove" @click.stop="tiles = tiles.filter((t) => t.id !== d.tile.id)"><v-icon name="close" x-small /></button>
				</header>
				<div class="tbody">
					<FastChart v-if="d.series.length" :time="trace.time" :series="d.series" :normalise="d.tile.normalise" :view-start="zoomStart" :view-end="zoomEnd"
						:zoom-tool="zoomTool" :cursor="cursor" :x-labels="bottom(i)" :x-title="xTitle" :bands="bands" :band-labels="topRow(i)" :start-ms="startMs"@zoom="emit('zoom', $event)" @hover="emit('hover', $event)" />
					<button v-else class="empty-tile" @click.stop="openMenu($event, d.tile)">＋ Pick series</button>
				</div>
			</article>
		</div>
		<FastSeriesMenu v-if="menu && menuTile" :key="menu.tile" :catalog="catalog" :selected="menuTile.series" :x="menu.x" :y="menu.y" @toggle="toggleSeries(menuTile, $event)" @close="close(true)" />
	</section>
</template>

<style scoped>
.plots { min-height: 0; }
.plots .fd-lid .grow { flex: 1 1 auto; }
.chip { max-width: 160px; }
.grid { flex: 1 1 auto; min-height: 0; display: grid; gap: 12px; padding: 12px; overflow: auto; align-content: start; }
.tile { min-height: 0; }
.thead { min-height: 32px; gap: 6px; padding: 0 6px 0 12px; font-weight: 650; }
.ttl { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.peak { font-size: var(--fs-sm, 12px); font-weight: 400; white-space: nowrap; }
.peak b { font-weight: 650; color: var(--theme--foreground); }
.fd-ib { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--fd-dim); cursor: pointer; font: inherit; font-weight: 700; }
.fd-ib:hover { background: var(--theme--background-normal); color: var(--theme--foreground); }
.fd-ib.on { background: var(--fd-tint); color: var(--fd-accent); }
.tbody { flex: 1 1 auto; min-height: 0; padding: 0 8px 2px 4px; }
.empty-tile { width: 100%; height: 100%; border: 0; background: transparent; color: var(--fd-dim); font: inherit; font-size: var(--fs-sm, 12px); cursor: pointer; }
.empty-tile:hover { color: var(--theme--foreground); }
/* phones: a tile's icon buttons are touch targets of 40px */
@container (max-width: 700px) {
	.fd-ib { width: 40px; height: 40px; }
	.peak { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }   /* the peak gives way before the title does */
	.thead { flex-wrap: nowrap; }   /* a tile title shortens with an ellipsis rather than pushing its buttons to a second row */
}
</style>
