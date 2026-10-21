<script setup lang="ts">
/*
 * What a profile with run windows adds to the run column (Conform): the run's window, "Use this view as the run
 * window", and, for a run with no log, uploading one or picking a log that is already uploaded. Each action
 * goes through the profile, then asks the page to reload the run. A refusal (an overlapping window, a
 * malformed file) is shown as the server or the parser worded it.
 */
import { computed, ref } from 'vue';
import type { Trace } from './fastCache';
import { useFastHost } from './host';
import type { RunProfile } from './profile';

const props = defineProps<{
	profile: RunProfile; detail: any; runData: unknown; trace: Trace | null;
	zoomStart: number | null; zoomEnd: number | null; busy: boolean;
}>();
// resetView: the run's data changed wholesale (a new log), so the old zoom means nothing
const emit = defineEmits<{ (e: 'changed', v: { resetView: boolean }): void }>();
const api = useFastHost().api;

const hasLog = computed(() => props.profile.hasLog?.(props.runData) ?? true);
const windowText = computed(() => props.profile.windowLabel?.(props.runData) ?? null);
const working = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const disabled = computed(() => working.value || props.busy);
const messageOf = (e: any): string => e?.response?.data?.errors?.[0]?.message || e?.message || 'The request failed.';

async function run(action: () => Promise<void>, resetView: boolean) {
	working.value = true; error.value = null; notice.value = null;
	try { await action(); emit('changed', { resetView }); } catch (e: any) { error.value = messageOf(e); } finally { working.value = false; }
}

// ---- the view as the window: the zoom, or the whole trace when nothing is zoomed
const view = computed(() => {
	const t = props.trace;
	if (!t || t.n < 2) return null;
	return { start: props.zoomStart ?? t.time[0], end: props.zoomEnd ?? t.time[t.n - 1] };
});
const mm = (s: number) => `${+(s / 60).toFixed(1)}`;
const viewText = computed(() => (view.value ? `${mm(view.value.start)}–${mm(view.value.end)} min` : ''));
function useView() {
	const v = view.value;
	if (!v) return;
	run(() => props.profile.setWindowFromView!(api, props.detail, props.runData, v.start, v.end), false);
}

// ---- upload
function onFile(ev: Event) {
	const input = ev.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';   // the same file can be chosen again after a refusal
	if (!file) return;
	run(async () => { notice.value = await props.profile.upload!(api, props.detail, file); }, true);
}

// ---- a log that is already uploaded
const picking = ref(false);
const candidates = ref<{ id: string; label: string }[] | null>(null);
async function togglePick() {
	picking.value = !picking.value;
	if (!picking.value || candidates.value) return;
	working.value = true; error.value = null;
	try { candidates.value = await props.profile.linkExisting!.list(api, props.detail); }
	catch (e: any) { error.value = messageOf(e); picking.value = false; }
	finally { working.value = false; }
}
function link(id: string) {
	picking.value = false;
	run(() => props.profile.linkExisting!.link(api, props.detail, id), true);
}
</script>

<template>
	<div class="act" aria-label="Run window and log">
		<div class="head"><b>Run window</b><span class="fd-dim">{{ windowText ?? (hasLog ? 'not set' : 'no log yet') }}</span></div>
		<div class="btns">
			<button v-if="profile.setWindowFromView && trace" class="fd-btn" :disabled="disabled || !view"
				title="Save the time range now shown on the plots as this run's window" @click="useView">Use this view as the run window<span v-if="viewText" class="fd-dim vt"> ({{ viewText }})</span></button>
			<label v-if="profile.upload && !hasLog" class="fd-btn" :class="{ off: disabled }">
				Upload a log (.csv)
				<input class="file" type="file" accept=".csv,text/csv,text/plain" :disabled="disabled" @change="onFile" />
			</label>
			<button v-if="profile.linkExisting && !hasLog" class="fd-btn" :aria-expanded="picking" :disabled="disabled" @click="togglePick">Use a log already uploaded</button>
		</div>
		<div v-if="picking" class="pick" role="list">
			<div v-if="working && !candidates" class="fd-dim">Looking for logs…</div>
			<div v-else-if="!candidates?.length" class="fd-dim">No logs from this machine within a day of the run's date.</div>
			<button v-for="c in candidates" :key="c.id" class="fd-card cand" role="listitem" :disabled="disabled" @click="link(c.id)">{{ c.label }}</button>
		</div>
		<div v-if="working" class="fd-spin"><v-progress-circular indeterminate small /> working…</div>
		<div v-if="error" class="msg err" role="alert">{{ error }}</div>
		<div v-if="notice" class="msg warn" role="status">{{ notice }}</div>
	</div>
</template>

<style scoped>
.act { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--fd-line); }
.head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: var(--fs-sm, 12px); }
.head .fd-dim { font-variant-numeric: tabular-nums; }
.btns { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.btns .fd-btn { height: auto; min-height: 28px; padding: 4px 10px; white-space: normal; text-align: center; }
.vt { margin-left: 4px; font-weight: 400; }
.file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
label.fd-btn { position: relative; }
label.fd-btn:focus-within { outline: 2px solid var(--fd-accent); outline-offset: 1px; }
label.fd-btn.off { opacity: 0.5; cursor: not-allowed; }
.pick { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; border: 1px solid var(--fd-line); border-radius: 8px; font-size: var(--fs-sm, 12px); }
.pick > .fd-dim { padding: 8px 10px; }
.cand { text-align: left; padding: 6px 10px; font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; border-bottom: 1px solid var(--fd-line); overflow-wrap: anywhere; }
.cand:last-child { border-bottom: 0; }
.cand:hover:not(:disabled) { background: var(--fd-tile); }
.msg { font-size: var(--fs-sm, 12px); overflow-wrap: anywhere; }
.err { color: var(--theme--danger); }
.warn { color: color-mix(in srgb, var(--theme--warning) 60%, var(--theme--foreground)); }
</style>
