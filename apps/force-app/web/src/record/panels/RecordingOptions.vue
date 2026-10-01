<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useWorkspace } from '../workspace';
import LookupField from './LookupField.vue';
import CutPicker from './CutPicker.vue';
import StatTile from './StatTile.vue';
import MachineOperatorPanel from './MachineOperatorPanel.vue';

const w = useWorkspace();

// #46: the app used to find out a sample rate was too high for the assigned NI-DAQ hardware only
// when acquisition itself threw a raw DAQmx error ("Maximum Value: 51.367188e3") -- flag it on the
// tile before the operator ever presses Start instead. Re-checked whenever the channel assignment
// changes (moving to a different module can change the achievable rate); null means "no real
// limit to check" (simulated hardware, or DAQmx isn't available here), not "unlimited by measurement".
const maxSampleRateHz = ref<number | null>(null);
async function checkMaxSampleRate() {
	if (w.source.value !== 'nidaq') { maxSampleRateHz.value = null; return; }
	const chans = w.nidaqChannels.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
	if (!chans.length) { maxSampleRateHz.value = null; return; }
	try {
		const res = await fetch(`${w.client.baseUrl}/nidaq/max_rate?channels=${encodeURIComponent(chans.join(','))}`);
		maxSampleRateHz.value = res.ok ? (await res.json()).max_rate_hz : null;
	} catch { maxSampleRateHz.value = null; }
}
watch([() => w.source.value, () => w.nidaqChannels.value], checkMaxSampleRate, { immediate: true });
const sampleRateInvalid = computed(() =>
	maxSampleRateHz.value !== null && w.cfg.sample_rate > maxSampleRateHz.value,
);
// Surface speed (m/min) = pi * diam(mm) * rpm / 1000 — the same formula buildRunPayload() already
// logs to Directus as machining_cutting_speed_m_per_min, just surfaced here too.
const replaySurfaceSpeed = computed(() => (Math.PI * w.replay.diam * w.replay.rpm) / 1000);
// Depth of cut: the schema splits axial/radial: prefer radial (the conventional "depth of cut" in
// turning) and fall back to axial when only that was recorded.
const replayDepthOfCut = computed(() => w.machining.radial_doc || w.machining.axial_doc || '—');
function fmtDuration(sec: number): string {
	if (!Number.isFinite(sec) || sec <= 0) return '—';
	const m = Math.floor(sec / 60), s = Math.round(sec % 60);
	return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
watch(() => w.source.value, (s) => { if (s === 'replay' && w.replay.options.length === 0) w.searchCuts(''); });
onMounted(() => { if (w.source.value === 'replay') w.searchCuts(''); });
// The cut list is also progressively filtered by Sample/Operation type/Machine (see
// workspace.ts's searchCuts) — re-run whenever any of those change while replay is active, so
// narrowing the metadata fields narrows the list live, not just on the next text search.
watch(() => [w.link.sampleId, w.link.equipmentId, w.meta.op_type], () => {
	if (w.source.value === 'replay') w.searchCuts(w.replay.query);
});

function searchEdgesForInsert(q: string) { return w.searchEdges(q, w.link.insertId || undefined); }

// Diameter: assume solid stock (one diameter) by default — Outer Ø and Inner Ø used to always be
// two separate tiles even though most cuts only ever set one. Double-clicking the single tile
// splits it, in the same grid footprint, into Outer/Inner for tube or annular stock; double-
// clicking Outer while split merges back down (zeroing inner — solid stock has none). Synced both
// ways so loading a config that already has a real inner diameter (a previous run, a copied setup)
// reveals the split view instead of hiding a nonzero value inside the collapsed one.
const diamSplit = ref(w.cfg.inner_diam > 0);
watch(() => w.cfg.inner_diam, (v) => { if (v > 0) diamSplit.value = true; });
function splitDiam() { diamSplit.value = true; }
function mergeDiam() { w.cfg.inner_diam = 0; diamSplit.value = false; }

// Folding subpanels (Direction B / "Cards"): each grouped section is independently collapsible,
// and how many start open responds to the actual height the grid has given this panel — a small
// window/monitor gets just Tooling; a tall one gets everything open. Tooling (Insert/Edge/Tool)
// is the baseline that's always open: per the earlier field-frequency review these change far more
// often between cuts than Machine/Operator do, so they're worth the space on any screen. Post-cut
// opens next as height allows (only relevant once the cut is done, so the least useful to show
// while setting one up). Coolant & geometry now live in MetadataPanel.vue's Advanced section, not
// here. Acquisition's processing toggles used to be a third card here but live in the footer now,
// next to Start — see RecordingActions.vue.
//
// `touched` records a card the OPERATOR has manually toggled, so a later resize (dragging the grid
// panel, moving the window to a different monitor) never fights a deliberate choice — auto-fold
// only ever adjusts a card the operator hasn't already decided about themselves.
const open = reactive({ tooling: true, postCut: false });
const touched = reactive({ tooling: false, postCut: false });
function toggleCard(card: keyof typeof open) {
	touched[card] = true;
	open[card] = !open[card];
}

// Least-essential-first: the order auto-fold closes cards in when content overflows.
const CLOSE_ORDER: (keyof typeof open)[] = ['postCut'];

// Measures instead of guessing: a fixed BASE/STEP pixel model can't know the real rendered height
// of this form (it's never been seen rendered from here), and the first version of this shipped
// with numbers that were simply too low — every card came out "open" on an ordinary screen and the
// panel scrolled anyway. This instead opens every untouched card, checks whether panel-body
// actually overflows (scrollHeight vs its own clientHeight), and if so closes cards one at a time,
// least-essential-first, re-checking after each — so it's correct by construction on any screen
// size instead of tuned-and-hopefully-right for one.
let fitting = false;
async function fitToScreen() {
	const container = rootEl.value?.parentElement;
	if (!container || fitting) return;
	fitting = true;
	try {
		if (!touched.tooling) open.tooling = true;
		for (const card of CLOSE_ORDER) if (!touched[card]) open[card] = true;
		await nextTick();
		for (const card of CLOSE_ORDER) {
			if (container.scrollHeight <= container.clientHeight + 1) break;
			if (touched[card] || !open[card]) continue;
			open[card] = false;
			await nextTick();
		}
	} finally {
		fitting = false;
	}
}

const rootEl = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
	// The height that matters is the SHARED panel-body's (see PanelFrame.vue's container-type:size),
	// not this component's own root — .opts has no fixed size of its own, its parent does.
	const container = rootEl.value?.parentElement;
	if (!container) return;
	void fitToScreen();
	if (typeof ResizeObserver === 'undefined') return;
	resizeObserver = new ResizeObserver(() => {
		// Debounced: a drag-resize of the grid panel fires many events in quick succession, and
		// each fit pass forces a couple of extra renders (see fitToScreen) — no reason to run that
		// on every intermediate frame instead of once the size settles.
		if (resizeDebounce) clearTimeout(resizeDebounce);
		resizeDebounce = setTimeout(fitToScreen, 120);
	});
	resizeObserver.observe(container);
});
onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	if (resizeDebounce) clearTimeout(resizeDebounce);
});
</script>

<template>
	<div class="opts" ref="rootEl">
		<!-- Source selector -->
		<div class="segmode lg source-seg">
			<button class="segbtn" :class="{ on: w.source.value === 'sim' }" :disabled="w.locked.value" @click="w.setSource('sim')">Simulated</button>
			<button class="segbtn" :class="{ on: w.source.value === 'replay' }" :disabled="w.locked.value" @click="w.setSource('replay')">Replay file</button>
			<button class="segbtn" :class="{ on: w.source.value === 'nidaq' }" :disabled="w.locked.value" @click="w.setSource('nidaq')">NI-DAQ</button>
		</div>

		<!-- ─── Sample — always first: this is "what am I recording/replaying", the identity of the
			 cut. Machine/Operator/Operation type (also identity-ish, but set-once-per-session facts
			 rather than per-cut ones) live together in their own subpanel below. ─── -->
		<div class="links">
			<LookupField v-model="w.link.sampleId" :display-label="w.link.sampleLabel" label="Sample" placeholder="search sample code…"
				icon="search" :search="w.searchSamples" :disabled="w.locked.value" @select="w.onSelectSample" />
		</div>

		<!-- ─── Feed & speed — the key numeric readout, right after identity. For sim/nidaq this is
			 the editable recording config; for replay it's the picked cut's own recorded values, so
			 the cut picker (which supplies that data) sits immediately above it. ─── -->
		<template v-if="w.source.value === 'sim' || w.source.value === 'nidaq'">
			<div class="stat-grid">
				<StatTile editable label="Spindle" unit="RPM" v-model="w.cfg.rpm" :disabled="w.locked.value" />
				<StatTile editable label="Feed" unit="mm/rev" step="0.01" v-model="w.cfg.feed" :disabled="w.locked.value" />
				<!-- Diameter: one tile (solid stock assumed) unless split — see script comment. -->
				<StatTile v-if="!diamSplit" editable label="Diameter" unit="mm" v-model="w.cfg.diam" :disabled="w.locked.value"
					class="span2" title="Double-click to split into outer/inner, for tube or annular stock" @dblclick="splitDiam" />
				<template v-else>
					<StatTile editable label="Outer Ø" unit="mm" v-model="w.cfg.diam" :disabled="w.locked.value"
						title="Double-click to merge back to a single diameter" @dblclick="mergeDiam" />
					<StatTile editable label="Inner Ø" unit="mm" v-model="w.cfg.inner_diam" :disabled="w.locked.value" />
				</template>
				<StatTile editable label="Sample rate" unit="Hz" v-model="w.cfg.sample_rate" :disabled="w.locked.value"
					:invalid="sampleRateInvalid"
					:title="sampleRateInvalid ? `Exceeds the assigned hardware's maximum of ${maxSampleRateHz?.toFixed(0)} Hz for this channel selection — recording would fail to start.` : ''" />
				<!-- Duration removed from view — but w.cfg.duration_sec is still real state: it drives
					 checkDiskBeforeStart()/estimatedRecordingGb() in workspace.ts, the pre-Start
					 disk-space warning. With no field left to change it, that warning now always
					 estimates off its fixed default (8s) rather than the actual planned length. Flagged
					 rather than silently left inaccurate — reinstate an input (even a hidden/advanced
					 one) if that warning still needs to mean something for real (nidaq) recordings. -->
				<StatTile editable label="Pulses/rev" v-model="w.cfg.ppr" :disabled="w.locked.value" />
			</div>
		</template>

		<template v-if="w.source.value === 'replay'">
			<!-- Cut picker: filtered by Sample/Operation type above, further narrowed by free-text
				 search. Picking one loads that operation's full original metadata (below) and the
				 readout right here. -->
			<CutPicker />
			<!-- Read-only: :model-value, not v-model. These tiles never expose their input branch
				 (no `editable`), so nothing ever emits update:modelValue — v-model would need every
				 value here to be an assignable expression, which the derived ones (surface speed,
				 depth of cut, capture, cut time) are not. -->
			<div v-if="w.replay.cacheId" class="stat-grid cut-params">
				<StatTile label="Feed" unit="mm/rev" :model-value="w.replay.feed" />
				<StatTile label="Diameter" unit="mm" :model-value="w.replay.diam" />
				<StatTile label="Inner Ø" unit="mm" :model-value="w.replay.innerDiam" />
				<StatTile label="Pulses/rev" :model-value="w.replay.ppr" />
				<StatTile label="Surface speed" unit="m/min" :model-value="replaySurfaceSpeed.toFixed(1)" />
				<StatTile label="Depth of cut" unit="mm" :model-value="replayDepthOfCut" />
				<StatTile label="Capture" unit="kHz" :model-value="(w.replay.sampleRate / 1000).toFixed(1)" />
				<StatTile label="Cut time" :model-value="fmtDuration(w.playback.state.duration)" />
			</div>
		</template>

		<!-- ─── Everything else ─── -->
		<div class="section-divider"><span>Details</span></div>

		<MachineOperatorPanel />

		<!-- NI-DAQ channel count used to be echoed here too ("N channels configured — edit in
			 Settings"); dropped as pure duplication of the Settings page itself, which is the only
			 place it's actually editable. -->

		<!-- Acquisition's processing toggles (Cut start / Drift / Converge) live only in the footer,
			 left of Start, in RecordingActions.vue — the one group of settings worth checking in the
			 moment right before pressing Start. A second "Recording behaviour" block of the same three
			 switches used to sit here too; their explanations and the cut-detect threshold are in
			 Settings > Recording. -->

		<div class="card" :class="{ collapsed: !open.tooling }">
			<button type="button" class="card-head" @click="toggleCard('tooling')">
				<span class="material-symbols-rounded chev">{{ open.tooling ? 'expand_more' : 'chevron_right' }}</span>
				<span class="material-symbols-rounded">build_circle</span>Tooling
			</button>
			<div v-show="open.tooling" class="card-body">
				<div class="links pair">
					<LookupField v-model="w.link.insertId" :display-label="w.link.insertLabel" label="Insert" placeholder="search insert code…"
						icon="change_history" :search="w.searchInserts" :disabled="w.locked.value" @select="(i: any) => { w.link.insertLabel = i.label; w.link.edgeId = ''; w.link.edgeLabel = ''; }" />
					<!-- New edge lives on the Edge field itself now (it's a property of the specific edge
						 in use, not a fact about the insert) — no longer a separate checkbox down by Chips
						 collected. -->
					<LookupField v-model="w.link.edgeId" :display-label="w.link.edgeLabel" label="Edge" placeholder="search edge code…"
						icon="change_history" :search="searchEdgesForInsert" :disabled="w.locked.value"
						@select="(i: any) => { w.link.edgeLabel = i.label; if (i.extra?.insertId) { w.link.insertId = i.extra.insertId; w.link.insertLabel = i.extra.insertLabel; } }">
						<template #badge>
							<button type="button" class="new-badge" :class="{ on: w.machining.new_edge }" :disabled="w.locked.value"
								title="Mark this as a new edge" @click="w.machining.new_edge = !w.machining.new_edge">
								<span class="material-symbols-rounded">fiber_new</span>
							</button>
						</template>
					</LookupField>
				</div>
				<div class="links">
					<LookupField v-model="w.link.toolId" :display-label="w.link.toolLabel" label="Tool" placeholder="search tool name…"
						icon="build" :search="w.searchToolsForOp" :disabled="w.locked.value" @select="(i: any) => (w.link.toolLabel = i.label)" />
				</div>
			</div>
		</div>

		<div class="card" :class="{ collapsed: !open.postCut }">
			<button type="button" class="card-head" @click="toggleCard('postCut')">
				<span class="material-symbols-rounded chev">{{ open.postCut ? 'expand_more' : 'chevron_right' }}</span>
				<span class="material-symbols-rounded">recycling</span>Post-cut
			</button>
			<div v-show="open.postCut" class="card-body">
				<!-- TODO: auto-generate + pre-fill from the cut parameters and the DB's ref-code
					 rules (still editable after). MetadataPanel.vue's `cutId` computed
					 ({sample_code}-{TYPE}{seq}) is the likely pattern but needs confirming against
					 the actual chips-ref rule before wiring it up — left as a plain field for now
					 rather than guessing at generation logic. -->
				<label>Chips ref code<input v-model="w.machining.chips_ref" :disabled="w.locked.value" /></label>
				<div class="chks">
					<label class="chk"><input type="checkbox" v-model="w.machining.chips_collected" :disabled="w.locked.value" /> Chips collected</label>
				</div>
			</div>
		</div>

		<label class="wide">Notes
			<textarea v-model="w.meta.notes" rows="2" :disabled="w.locked.value"></textarea>
		</label>
	</div>
</template>

<style scoped>
/* No overflow/max-height here: PanelFrame's own .panel-body is already the scroll container.
   Nesting a second auto-overflow box inside it let the two end up with independent scroll
   positions — the outer at 0 while this one had scrolled itself, which read as the very top row
   (the Simulated/Replay/NI-DAQ source buttons) being clipped even though the panel was at rest. */
.opts { display: flex; flex-direction: column; gap: 10px; }
/* Three equal choices across a narrow column: they share its width and may wrap to two lines. */
.source-seg { display: flex; }
.source-seg .segbtn { flex: 1; height: auto; min-height: 32px; padding: 4px 6px; white-space: normal; line-height: 1.2; }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
.stat-grid.cut-params { margin-top: -2px; }
.stat-grid .span2 { grid-column: 1 / -1; }
label { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin-bottom: 8px; }
label.wide { display: block; }
input:not([type="checkbox"]), textarea, select { display: block; width: 100%; margin-top: 3px; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; outline: none; font-family: inherit; }
select option { background: var(--bg); color: var(--text); }
textarea { font-family: var(--mono); font-size: var(--fs-sm); resize: vertical; }
input:focus, textarea:focus, select:focus { border-color: var(--accent); }
input:disabled, textarea:disabled, select:disabled { opacity: 0.55; }
.section-divider { display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
.section-divider::before, .section-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
/* Folding subpanels (Direction B / "Cards"): Tooling, Coolant & geometry, Post-cut. Body content
   is v-show (not v-if) so folding a card never remounts/resets a LookupField's own search state —
   it just hides. */
.card { border: 1px solid var(--border); background: rgba(255,255,255,0.02); border-radius: 10px; padding: 10px 11px; }
.card + .card { margin-top: 2px; }
.card.collapsed { padding-bottom: 10px; }
.card-head { display: flex; align-items: center; gap: 6px; width: 100%; margin: -4px -4px 5px; padding: 4px; border-radius: 6px; background: transparent; border: none; outline: none; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--text-dim); cursor: pointer; }
.card-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.card.collapsed .card-head { margin-bottom: -4px; }
.card-head .material-symbols-rounded { font-size: var(--icon-xs); color: var(--accent); }
.card-head .chev { font-size: var(--icon-sm); color: var(--text-dim); margin-right: -2px; }
.card-head:hover { color: var(--text); }
/* New-edge toggle, inline in the Edge LookupField's own box via its #badge slot — a property of
   this specific edge, not a fact about the insert, so it lives next to Edge, not off in its own
   checkbox elsewhere. */
.new-badge { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-right: 4px; padding: 0; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-faint); cursor: pointer; }
.new-badge .material-symbols-rounded { font-size: var(--icon-sm); }
.new-badge.on { border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.new-badge:disabled { opacity: 0.5; cursor: not-allowed; }
.links { display: flex; flex-direction: column; }
.links :deep(.lookup) { min-width: 0; }
/* Two lookups side by side (Machine|Operator, Insert|Edge) to save vertical space. Each LookupField
   is position:relative with its own absolute dropdown, so the grid columns don't clip the menus. */
.links.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.chks { display: flex; gap: 16px; margin-top: 4px; }
.chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); color: var(--text); cursor: pointer; }
.chk input { accent-color: var(--accent); }

/* --- Adaptive compression ------------------------------------------------------------------
   PanelFrame's .panel-body declares `container-type:size` under the name "panel-body" (see
   PanelFrame.vue), so this panel can react to the ACTUAL space the grid has given it, not just
   scroll once content overflows. Spacing/padding tightens first, then the notes box gives up its
   minimum height — never the field labels themselves, since most fields here have no leading icon
   to fall back on for identification. If that still isn't enough, panel-body's own
   overflow-y:auto (unchanged) takes over.

   The thresholds below are a first estimate sized off this form's own field count/spacing, not
   measured against the live grid panel (its actual pixel width depends on RecordPage.vue's grid
   units, not a fixed mockup width) — resize the Recording & Metadata panel in the running app and
   retune these two numbers to wherever it actually starts feeling cramped. --------------------- */
@container panel-body (max-height: 760px) {
	.opts { gap: 6px; }
	.links :deep(.lookup) { margin-bottom: 4px; }
	label { margin-bottom: 4px; }
	.stat-grid { gap: 5px; margin-bottom: 4px; }
	.stat-grid :deep(.stat-tile) { padding: 6px 9px; }
	.stat-grid :deep(.value-text), .stat-grid :deep(.value input) { font-size: var(--fs-md); }
	.section-divider { margin: 4px 0 1px; }
	.card { padding: 7px 9px; }
	.card + .card { margin-top: 0; }
	.card-head { margin-bottom: 6px; }
}
@container panel-body (max-height: 600px) {
	label.wide textarea { min-height: 0; }
}
</style>
