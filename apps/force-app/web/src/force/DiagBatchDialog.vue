<script setup lang="ts">
// "Apply recipe to selected": pick a library recipe, see what would be queued / skipped / refused
// (planBatch), then queue it. Each queued cut gets exactly the request the single Build / Bake
// makes (buildPatch -> PATCH machining_force_analysis), one at a time, with progress and a Cancel
// that takes effect before the next item. The host orchestrator does the actual work, one cut
// after another, so "queued" means "waiting for the host", not "built". A modal like PlotHelp:
// Escape closes (not mid-run: Cancel first), Tab stays inside, focus returns to the opener.
import { computed, onMounted, ref } from 'vue';
import {
	fetchRecipeLibrary, planBatch, runBatch, summaryLine, useModalFocus,
	type BatchRow, type BatchSummary, type SavedRecipe,
} from '@d1/force-plotting';
import { api } from '../directusClient';

const props = defineProps<{ rows: BatchRow[] }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'finished'): void }>();

const rootEl = ref<HTMLElement | null>(null);
const firstEl = ref<HTMLSelectElement | null>(null);
const library = ref<SavedRecipe[]>([]);
const libErr = ref<string | null>(null);
const recipeId = ref('');
const rebuild = ref(false);
const running = ref(false);
const cancelRequested = ref(false);
const progress = ref<{ done: number; total: number; current: string | null } | null>(null);
const summary = ref<BatchSummary | null>(null);

const chosen = computed(() => library.value.find((r) => r.recipe_id === recipeId.value) ?? null);
const plan = computed(() => chosen.value ? planBatch(props.rows, chosen.value.recipe, { rebuild: rebuild.value }) : []);
const counts = computed(() => ({
	queue: plan.value.filter((p) => p.action === 'queue').length,
	skip: plan.value.filter((p) => p.action === 'skip').length,
	refuse: plan.value.filter((p) => p.action === 'refuse').length,
}));

async function start() {
	if (!chosen.value || running.value || !counts.value.queue) return;
	running.value = true; cancelRequested.value = false; summary.value = null;
	try {
		summary.value = await runBatch({
			plan: plan.value,
			recipe: chosen.value.recipe,
			request: (id, patch) => api.patch(`/items/machining_force_analysis/${id}`, patch),
			shouldCancel: () => cancelRequested.value,
			onProgress: (p) => { progress.value = p; },
		});
	} finally {
		running.value = false;
		emit('finished');
	}
}
function close() { if (!running.value) emit('close'); }

useModalFocus(rootEl, { onEscape: close, initialFocus: () => firstEl.value?.focus() });
onMounted(async () => {
	try { library.value = await fetchRecipeLibrary(); }
	catch (e: unknown) { libErr.value = (e as { message?: string })?.message || 'could not load the recipe library'; }
});
</script>

<template>
	<Teleport to="body">
		<div class="bd-scrim" @pointerdown.self="close">
			<div ref="rootEl" class="bd-card" role="dialog" aria-modal="true" aria-labelledby="bd-title">
				<div class="bd-head"><strong id="bd-title">Apply recipe to {{ rows.length }} selected</strong></div>
				<div class="bd-body">
					<template v-if="!summary">
						<label class="bd-field">
							<span>Recipe</span>
							<select ref="firstEl" v-model="recipeId" :disabled="running">
								<option value="">— choose a saved recipe —</option>
								<option v-for="r in library" :key="r.recipe_id" :value="r.recipe_id">{{ r.name }}</option>
							</select>
						</label>
						<p v-if="libErr" class="bd-err" role="alert">{{ libErr }}</p>
						<label class="bd-check">
							<input v-model="rebuild" type="checkbox" :disabled="running">
							Rebuild cuts already built with this recipe
						</label>
						<p v-if="chosen" class="bd-plan">
							<strong>{{ counts.queue }}</strong> to queue,
							<strong>{{ counts.skip }}</strong> skipped,
							<strong>{{ counts.refuse }}</strong> refused.
						</p>
						<ul v-if="chosen && (counts.skip || counts.refuse)" class="bd-list">
							<template v-for="p in plan" :key="p.id">
								<li v-if="p.action !== 'queue'">{{ p.code }}: {{ p.reason }}</li>
							</template>
						</ul>
						<div v-if="running && progress" class="bd-progress" role="status">
							<progress :max="progress.total" :value="progress.done" />
							{{ progress.done }} / {{ progress.total }}<span v-if="progress.current"> — {{ progress.current }}</span>
							<span v-if="cancelRequested"> (cancelling after this item)</span>
						</div>
					</template>
					<template v-else>
						<p class="bd-plan" role="status"><strong>{{ summaryLine(summary) }}.</strong></p>
						<p class="bd-note">Queued cuts are now waiting for the host orchestrator, which analyses them one at a time. Refresh the list to watch them turn built.</p>
						<ul class="bd-list">
							<li v-for="i in summary.skipped" :key="'s' + i.id">Skipped {{ i.code }}: {{ i.reason }}</li>
							<li v-for="i in summary.refused" :key="'r' + i.id" class="bd-err">Refused {{ i.code }}: {{ i.reason }}</li>
							<li v-for="i in summary.notRun" :key="'n' + i.id">Not run {{ i.code }}</li>
						</ul>
					</template>
				</div>
				<div class="bd-foot">
					<template v-if="!summary">
						<button v-if="running" type="button" :disabled="cancelRequested" @click="cancelRequested = true">Cancel</button>
						<button v-else type="button" @click="close">Close</button>
						<button type="button" class="primary" :disabled="running || !counts.queue" @click="start">
							Queue {{ counts.queue }}
						</button>
					</template>
					<button v-else type="button" class="primary" @click="emit('close')">Done</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.bd-scrim { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(2, 6, 23, 0.5); }
.bd-card {
	width: min(520px, 100%); max-height: min(80vh, 640px); display: flex; flex-direction: column;
	background: var(--bg-1, #0f172a); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 10px;
	box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); font-size: var(--fs-sm); line-height: 1.45;
}
.bd-head { padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--accent, #7dd3fc); font-size: var(--fs-md); }
.bd-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.bd-field { display: flex; flex-direction: column; gap: 3px; color: var(--text-dim); }
.bd-field select { font: inherit; padding: 5px 7px; background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 5px; }
.bd-check { display: flex; gap: 6px; align-items: center; }
.bd-plan, .bd-note { margin: 0; }
.bd-note { color: var(--text-dim); }
.bd-list { margin: 0; padding-left: 18px; color: var(--text-dim); max-height: 200px; overflow: auto; }
.bd-err { color: var(--danger, #fca5a5); margin: 0; }
.bd-progress { display: flex; align-items: center; gap: 8px; }
.bd-progress progress { flex: 1; }
.bd-foot { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--border); }
.bd-foot button { font: inherit; padding: 4px 12px; border-radius: 5px; cursor: pointer; color: var(--text, #e5e7eb); background: var(--bg-2); border: 1px solid var(--border); }
.bd-foot button.primary { border-color: var(--accent, #38bdf8); color: var(--accent, #38bdf8); }
.bd-foot button:disabled { opacity: 0.5; cursor: not-allowed; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #38bdf8) 55%, transparent); }
</style>
