<script setup lang="ts">
// Diagnostics Workbench as its own window, deliberately OUTSIDE the generalised force viewer.
//
// This was previously a panel type in the shared ForceDashboard, which meant a specialist,
// still-incomplete analysis surface sat inside the everyday plotting dashboard in both hosts
// (Directus and this app). Two problems with that: it degraded the dashboard for everyone not
// doing diagnostics, and the shared WorkbenchPanel chrome renders raw
// <span class="material-symbols-rounded"> ligatures, which Directus does not load the font for
// -- so the panel titles showed literal "scatter_plot" / "drag_indicator" text there. This app
// DOES load Material Symbols (see index.html), so the same components render correctly here.
//
// The build trigger moved here with it: removing the panel from the dashboard orphaned the only
// way to request a diag build, so the picker below lists every analysed operation (not just the
// ones already built) and offers Build/Retry per its diag state.
//
// Heavy computation stays server-side and is untouched by this move: scripts/diag (Getis-Ord
// Gi*, HDBSCAN/GLOSH, TSA, radial detrend, envelope) runs on the host via the orchestrator's
// process_diag_row, which bakes every per-point statistic into attrs.d1an and the diag octree.
// The browser only thresholds and highlights what the server already computed.
import { computed, onMounted, ref } from 'vue';
import { attachCampaigns, buildPatch, toPickerRow, type BatchRow, type CampaignInfo, type DiagState, type Recipe } from '@d1/force-plotting';
import { api } from '../directusClient';
import StandaloneDiagnosticsWorkbench from './StandaloneDiagnosticsWorkbench.vue';
import DiagPicker from './DiagPicker.vue';
import DiagBatchDialog from './DiagBatchDialog.vue';

interface Row {
	id: string;
	diag_status: DiagState;
	diag_path: string | null;
	diag_points: number | null;
	diag_error: string | null;
	diag_metrics: Record<string, unknown> | null;
	diag_recipe: Recipe | null;
	operation_id?: {
		operation_id?: string; pass_code?: string; operation_date?: string;
		sample_id?: { sample_id?: string; sample_code?: string; nickname?: string } | null;
		/** The foreign key as fetched; attachCampaigns swaps in the campaign record when it is readable. */
		campaign_id?: string | { campaign_id?: string; campaign_code?: string | null; name?: string | null } | null;
	} | null;
}

const rows = ref<Row[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(false);
const err = ref<string | null>(null);
const building = ref(false);
const buildMsg = ref<string | null>(null);

const DIAG_FIELDS = [
	'id', 'diag_status', 'diag_path', 'diag_points', 'diag_error', 'diag_metrics', 'diag_recipe',
	'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.operation_date',
	'operation_id.sample_id.sample_id', 'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname',
	// The foreign key only: a nested campaign read is a 403 for a role that cannot read campaigns,
	// which would leave the picker empty. The campaign records are fetched apart (loadCampaigns).
	'operation_id.campaign_id',
];

const selected = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null);
const ready = computed(() => selected.value?.diag_status === 'done' && !!selected.value?.diag_path);

function label(r: Row): string {
	return r.operation_id?.pass_code || r.operation_id?.operation_id || r.id;
}
// null = the campaigns table could not be read (a role without access): the picker then groups by
// sample only. Never blocks the list.
const campaigns = ref<CampaignInfo[] | null>(null);
const pickerRows = computed(() => rows.value.map(toPickerRow));
async function loadCampaigns() {
	try {
		const res = await api.get('/items/campaigns', { params: { fields: ['campaign_id', 'campaign_code', 'name'], limit: -1 } });
		campaigns.value = res.data?.data ?? [];
	} catch {
		campaigns.value = null;
	}
}
const checked = ref<string[]>([]);
const batchOpen = ref(false);
const batchRows = computed<BatchRow[]>(() => {
	const ids = new Set(checked.value);
	return rows.value.filter((r) => ids.has(r.id)).map((r) => ({
		id: r.id, code: label(r), diag_status: r.diag_status, diag_path: r.diag_path, diag_recipe: r.diag_recipe,
	}));
});

async function loadRows() {
	loading.value = true; err.value = null;
	try {
		const res = await api.get('/items/machining_force_analysis', {
			params: {
				// Only cuts whose base analysis succeeded can be diagnosed -- process_diag_row
				// needs the archive .mat that produced them.
				filter: { status: { _eq: 'done' } },
				limit: -1,
				sort: '-created_at',
				fields: DIAG_FIELDS,
			},
		});
		await loadCampaigns();
		rows.value = attachCampaigns((res.data?.data ?? []) as Row[], campaigns.value);
		if (!selectedId.value && rows.value.length) {
			// Prefer something already built, so the window opens on a usable view.
			selectedId.value = (rows.value.find((r) => r.diag_status === 'done') ?? rows.value[0]).id;
		}
	} catch (e: any) {
		err.value = e?.message || 'failed to load operations';
	} finally {
		loading.value = false;
	}
}
onMounted(loadRows);

// Request/poll, moved verbatim in shape from the dashboard panel this replaces: PATCH the row to
// 'pending' and let the host orchestrator daemon claim it (scripts/force_orchestrator.py's
// claim_diag). If nothing is polling, the row simply stays pending -- hence the hint in the
// timeout message.
async function build(recipe?: Recipe) {
	const r = selected.value;
	if (!r?.id || building.value) return;
	building.value = true; buildMsg.value = 'Requesting diagnostics build on the host…';
	try {
		// buildPatch is shared with "Apply recipe to selected" so both send the same request.
		// A Bake from the workbench carries the edited recipe; persist it so process_diag_row
		// bakes it and claim_diag's hash reflects it. A plain Build/Retry leaves diag_recipe
		// untouched (NULL = the built-in default). Painted layers need no plumbing here: the
		// workbench writes diag_layer rows directly, and process_diag_row reads them at bake.
		const patch = buildPatch(recipe);
		if (recipe) r.diag_recipe = recipe;
		await api.patch(`/items/machining_force_analysis/${r.id}`, patch);
		buildMsg.value = 'Analysing on the host (minutes for large ops)…';
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((res) => setTimeout(res, 3000));
			const res = await api.get(`/items/machining_force_analysis/${r.id}`, { params: { fields: DIAG_FIELDS } });
			const row = res.data?.data ? attachCampaigns([res.data.data as Row], campaigns.value)[0] : undefined;
			if (!row) continue;
			if (row.diag_status === 'done' && row.diag_path) {
				Object.assign(r, row);
				buildMsg.value = null; return;
			}
			if (row.diag_status === 'error') {
				Object.assign(r, row);
				buildMsg.value = `Analysis failed: ${row.diag_error || 'unknown'}`; return;
			}
		}
		buildMsg.value = 'Still analysing — check back shortly (is the force orchestrator daemon running?).';
	} catch (e: any) {
		buildMsg.value = e?.response?.status === 403
			? "Your role can't request builds."
			: (e?.message || 'diagnostics request failed');
	} finally {
		building.value = false;
	}
}
</script>

<template>
	<div class="diag-page">
		<header class="diag-bar">
			<span class="diag-kicker">Diagnostics Workbench</span>
			<span v-if="selected?.diag_status === 'done'" class="diag-meta">
				{{ Number(selected.diag_points || 0).toLocaleString() }} pts
			</span>
			<!-- Only shown when there is nothing to work with yet. Once a cut is baked, the
			     Pipeline panel's "Bake recipe" is the single bake action -- two buttons calling
			     the same build() under different names ("Rebuild" here, "Re-bake" there) was
			     the top confusion in the field report. -->
			<button
				v-if="selected && !ready"
				class="btn sm primary"
				:disabled="building"
				:title="selected.diag_status === 'error'
					? 'The last host run failed. Fix the cause, then run it again.'
					: 'No analysis exists for this cut yet — run the pipeline on the host to create one.'"
				@click="build()"
			>
				{{ building ? 'Requesting…' : (selected.diag_status === 'error' ? 'Retry' : 'Build') }}
			</button>
			<button
				class="btn sm" :disabled="!checked.length || building"
				title="Queue a saved recipe on every ticked operation (skips ones already built with it)"
				@click="batchOpen = true"
			>Apply recipe to {{ checked.length }} selected…</button>
			<button class="btn sm" :disabled="loading || building" title="Reload the operation list from the database" @click="loadRows">Refresh</button>
		</header>

		<DiagBatchDialog v-if="batchOpen" :rows="batchRows" @close="batchOpen = false" @finished="loadRows" />

		<p v-if="err" class="diag-note error">{{ err }}</p>
		<!-- While a workbench is open the bake state belongs in its own state strip, next to
		     "what am I looking at" -- a note up here was easy to miss and left the strip
		     claiming "baked" during a bake. -->
		<p v-else-if="buildMsg && !ready" class="diag-note">{{ buildMsg }}</p>

		<div class="diag-body">
			<DiagPicker
				:rows="pickerRows" :selected-id="selectedId" v-model:checked="checked"
				:by-campaign="campaigns !== null" :loading="loading" :disabled="building" @select="(id) => (selectedId = id)"
			/>
			<div class="diag-main">
			<StandaloneDiagnosticsWorkbench
				v-if="ready && selected"
				:key="selected.id"
				:diag-path="selected.diag_path as string"
				:analysis-id="selected.id"
				:op-tag="label(selected)"
				:diag-metrics="selected.diag_metrics"
				:initial-recipe="selected.diag_recipe"
				:baked-recipe="selected.diag_recipe"
				:baking="building"
				:bake-message="buildMsg"
				@bake="build"
			/>
			<div v-else class="diag-empty">
				<p v-if="!selected">Select an operation to diagnose.</p>
				<p v-else-if="selected.diag_status === 'error'" class="error">
					Last build failed: {{ selected.diag_error }}
				</p>
				<p v-else-if="selected.diag_status === 'pending' || selected.diag_status === 'processing'">
					Queued on the host — waiting for the orchestrator daemon to pick it up.
				</p>
				<p v-else>No diagnostics analysis yet for this operation.</p>
			</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.diag-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.diag-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.diag-kicker { font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.01em; }
.diag-meta { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.diag-note { margin: 0; padding: 7px 14px; font-size: var(--fs-sm); color: var(--text-dim); font-style: italic; }
.diag-note.error, .error { color: var(--danger, #fca5a5); font-style: normal; }
.diag-body { flex: 1; min-height: 0; display: flex; }
.diag-body > * { flex: 1; min-width: 0; }
.diag-main { display: flex; min-width: 0; min-height: 0; }
.diag-main > * { flex: 1; min-width: 0; }
.diag-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: var(--fs-md); }
</style>
