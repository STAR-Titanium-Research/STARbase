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
import type { Recipe } from '@d1/force-plotting';
import { api } from '../directusClient';
import StandaloneDiagnosticsWorkbench from './StandaloneDiagnosticsWorkbench.vue';

type DiagState = 'done' | 'pending' | 'processing' | 'error' | null;

interface Row {
	id: string;
	diag_status: DiagState;
	diag_path: string | null;
	diag_points: number | null;
	diag_error: string | null;
	diag_metrics: Record<string, unknown> | null;
	diag_recipe: Recipe | null;
	operation_id?: { operation_id?: string; pass_code?: string; operation_date?: string } | null;
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
];

const selected = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null);
const ready = computed(() => selected.value?.diag_status === 'done' && !!selected.value?.diag_path);

function label(r: Row): string {
	return r.operation_id?.pass_code || r.operation_id?.operation_id || r.id;
}
// A short state tag beside each option so the picker itself shows what needs building, rather
// than making the user select an operation to find out.
function tag(r: Row): string {
	switch (r.diag_status) {
		case 'done': return '✓';
		case 'error': return '✗';
		case 'pending':
		case 'processing': return '…';
		default: return '·';
	}
}

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
		rows.value = res.data?.data ?? [];
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
		const patch: Record<string, unknown> = {
			diag_status: 'pending', diag_requested_at: new Date().toISOString(),
		};
		// A Bake from the workbench carries the edited recipe; persist it so process_diag_row
		// bakes it and claim_diag's hash reflects it. A plain Build/Retry leaves diag_recipe
		// untouched (NULL = the built-in default). Painted layers need no plumbing here: the
		// workbench writes diag_layer rows directly, and process_diag_row reads them at bake.
		if (recipe) { patch.diag_recipe = recipe; r.diag_recipe = recipe; }
		await api.patch(`/items/machining_force_analysis/${r.id}`, patch);
		buildMsg.value = 'Analysing on the host (minutes for large ops)…';
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((res) => setTimeout(res, 3000));
			const res = await api.get(`/items/machining_force_analysis/${r.id}`, { params: { fields: DIAG_FIELDS } });
			const row = res.data?.data as Row | undefined;
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
			? 'Not permitted (admin only) to request a host build.'
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
			<select v-model="selectedId" class="diag-picker" :disabled="loading || building">
				<option v-if="!rows.length" :value="null">{{ loading ? 'Loading…' : 'No analysed operations' }}</option>
				<option v-for="r in rows" :key="r.id" :value="r.id">{{ tag(r) }} {{ label(r) }}</option>
			</select>
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
			<button class="btn sm" :disabled="loading || building" title="Reload the operation list from the database" @click="loadRows">Refresh</button>
		</header>

		<p v-if="err" class="diag-note error">{{ err }}</p>
		<!-- While a workbench is open the bake state belongs in its own state strip, next to
		     "what am I looking at" -- a note up here was easy to miss and left the strip
		     claiming "baked" during a bake. -->
		<p v-else-if="buildMsg && !ready" class="diag-note">{{ buildMsg }}</p>

		<div class="diag-body">
			<StandaloneDiagnosticsWorkbench
				v-if="ready && selected"
				:key="selected.id"
				:diag-path="selected.diag_path as string"
				:analysis-id="selected.id"
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
</template>

<style scoped>
.diag-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.diag-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.diag-kicker { font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.01em; }
.diag-picker {
	flex: 1; min-width: 220px; max-width: 560px; font: inherit; font-size: var(--fs-md); padding: 6px 8px;
	background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 7px;
}
.diag-meta { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.diag-note { margin: 0; padding: 7px 14px; font-size: var(--fs-sm); color: var(--text-dim); font-style: italic; }
.diag-note.error, .error { color: var(--danger, #fca5a5); font-style: normal; }
.diag-body { flex: 1; min-height: 0; display: flex; }
.diag-body > * { flex: 1; min-width: 0; }
.diag-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: var(--fs-md); }
</style>
