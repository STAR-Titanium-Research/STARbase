<script setup lang="ts">
/*
 * What a profile with run windows adds to the run column (Conform): the run's window and, for someone who can edit
 * the run, "Use this view as the run window", uploading a log or picking a log that is already uploaded (for a run
 * with no log), and "Unlink log" / "Replace log" (for a run with one). A reader who cannot edit the run sees the
 * window and nothing to press. Each action goes through the profile, then asks the page to reload the run. A refusal
 * by our own hooks (an overlapping window) or the parser (a malformed file) is shown as they worded it; any other
 * failure is a plain sentence, never Directus's developer text.
 *
 * Look: DESIGN 4, 6 and 7. Buttons are the kit's IndexActions `.btn` (30px, 8px radius, tile ground, accent border on
 * hover; 40px under 700px). The two inline confirms are a group inside a polite live region, move the focus to Cancel
 * when they open and give it back to the button that opened them; the destructive one is drawn as danger.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ConformLogError, formatUkTime, plainReason } from './conform';
import type { Trace } from './fastCache';
import { useFastHost } from './host';
import type { LinkCandidate, RunProfile, UploadOutcome } from './profile';

const props = defineProps<{
	profile: RunProfile; detail: any; runData: unknown; trace: Trace | null;
	zoomStart: number | null; zoomEnd: number | null; busy: boolean;
	/** Whether the reader may change the run: false hides every action that writes (null while unknown shows them; the server decides). */
	canEdit?: boolean | null;
}>();
// resetView: the run's data changed wholesale (a new log), so the old zoom means nothing
const emit = defineEmits<{ (e: 'changed', v: { resetView: boolean }): void }>();
const api = useFastHost().api;

const editable = computed(() => props.canEdit !== false);
const hasLog = computed(() => props.profile.hasLog?.(props.runData) ?? true);
const windowText = computed(() => props.profile.windowLabel?.(props.runData) ?? null);
const working = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const disabled = computed(() => working.value || props.busy);
// a ConformLogError is already worded for a person; any other failure becomes a plain sentence (a hook's own reason, or "You can't change this Conform run.")
const messageOf = (e: unknown): string => (e instanceof ConformLogError ? e.message : plainReason(e, 'Could not complete that. Try again.'));

// the logs on offer in "Use a log already uploaded" (and the windows on them)
const candidates = ref<LinkCandidate[] | null>(null);

async function run(action: () => Promise<void>, resetView: boolean) {
	working.value = true; error.value = null; notice.value = null;
	try {
		await action();
		candidates.value = null;   // the run changed, so the logs on offer and the windows on them are stale
		emit('changed', { resetView });
	} catch (e: unknown) { error.value = messageOf(e); } finally { working.value = false; }
}

// ---- the view as the window: the zoom, or the whole trace when nothing is zoomed
const view = computed(() => {
	const t = props.trace;
	if (!t || t.n < 2) return null;
	return { start: props.zoomStart ?? t.time[0], end: props.zoomEnd ?? t.time[t.n - 1] };
});
// The view in the same unit as the run's window above it: UK clock times, as they will be saved (whole seconds). Minutes only for a log with no clock.
const mm = (s: number) => `${+(s / 60).toFixed(1)}`;
const viewText = computed(() => {
	const v = view.value;
	if (!v) return '';
	const t0 = props.profile.startMs?.(props.runData);
	if (t0 == null) return `${mm(v.start)}–${mm(v.end)} min`;
	return `${formatUkTime(t0 + Math.round(v.start) * 1000)} – ${formatUkTime(t0 + Math.round(v.end) * 1000)}`;
});
function useView() {
	const v = view.value;
	if (!v) return;
	run(() => props.profile.setWindowFromView!(api, props.detail, props.runData, v.start, v.end), false);
}

// ---- upload
const duplicate = ref<NonNullable<UploadOutcome['existing']> | null>(null);   // the chosen file is already uploaded as this log
function onFile(ev: Event) {
	const input = ev.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';   // the same file can be chosen again after a refusal
	if (!file) return;
	duplicate.value = null;
	run(async () => {
		const out = await props.profile.upload!(api, props.detail, file);
		if (out.existing) { duplicate.value = out.existing; return; }
		notice.value = out.warning;
	}, true);
}
function useDuplicate() {
	const d = duplicate.value;
	if (!d) return;
	duplicate.value = null;
	run(() => props.profile.linkExisting!.link(api, props.detail, d.id), true);
}

// ---- a log that is already uploaded
const picking = ref(false);
async function loadCandidates() {
	working.value = true; error.value = null;
	try { candidates.value = await props.profile.linkExisting!.list(api, props.detail); }
	catch (e: unknown) { error.value = messageOf(e); picking.value = false; }
	finally { working.value = false; }
}
async function togglePick() {
	picking.value = !picking.value;
	if (picking.value && !candidates.value) await loadCandidates();
}
function link(id: string) {
	picking.value = false;
	duplicate.value = null;
	run(() => props.profile.linkExisting!.link(api, props.detail, id), true);
}

// ---- unlink and replace (a run that has a log)
const confirming = ref<'unlink' | 'replace' | null>(null);
async function unlink() {
	const replacing = confirming.value === 'replace';
	confirming.value = null;
	await run(() => props.profile.unlink!(api, props.detail), true);
	if (replacing && !error.value) { picking.value = true; await loadCandidates(); }
}

// ---- focus: Cancel when a confirm opens, the opening button when it is cancelled
const cancelUnlink = ref<HTMLButtonElement | null>(null);
const cancelDuplicate = ref<HTMLButtonElement | null>(null);
const unlinkBtn = ref<HTMLButtonElement | null>(null);
const replaceBtn = ref<HTMLButtonElement | null>(null);
watch(confirming, (v) => { if (v) nextTick(() => cancelUnlink.value?.focus()); });
watch(duplicate, (v) => { if (v) nextTick(() => cancelDuplicate.value?.focus()); });
function cancelConfirm() {
	const was = confirming.value;
	confirming.value = null;
	nextTick(() => (was === 'replace' ? replaceBtn.value : unlinkBtn.value)?.focus());
}
</script>

<template>
	<div class="act" aria-label="Run window and log">
		<div class="head"><b>Run window</b><span class="fd-dim">{{ windowText ?? (hasLog ? 'not set' : 'no log yet') }}</span></div>
		<div v-if="editable" class="btns">
			<button v-if="profile.setWindowFromView && trace" class="btn stack" :disabled="disabled || !view"
				title="Save the time range now shown on the plots as this run's window" @click="useView">
				<span>Use this view as the run window</span><span v-if="viewText" class="fd-dim vt">{{ viewText }}</span>
			</button>
			<label v-if="profile.upload && !hasLog" class="btn" :class="{ off: disabled }">
				Upload a log (.csv)
				<input class="file" type="file" accept=".csv,text/csv,text/plain" :disabled="disabled" @change="onFile" />
			</label>
			<button v-if="profile.linkExisting && !hasLog" class="btn" :aria-expanded="picking" :disabled="disabled" @click="togglePick">Use a log already uploaded</button>
			<template v-if="profile.unlink && hasLog">
				<button ref="unlinkBtn" class="btn" :disabled="disabled" title="Take this log off the run and clear its window, summary and steps" @click="confirming = 'unlink'">Unlink log</button>
				<button v-if="profile.linkExisting || profile.upload" ref="replaceBtn" class="btn" :disabled="disabled" title="Unlink this log, then upload another or pick one" @click="confirming = 'replace'">Replace log</button>
			</template>
		</div>
		<!-- the live region is always in the page, so a confirm that opens in it is announced -->
		<div class="slot" aria-live="polite">
			<div v-if="confirming" class="confirm" role="group" :aria-label="confirming === 'replace' ? 'Replace the log' : 'Unlink the log'">
				<span>{{ confirming === 'replace' ? 'This unlinks the log, then lets you upload another or pick one.' : 'This unlinks the log.' }} It clears the run window, summary and steps. A log no other run uses is deleted.</span>
				<span class="row">
					<button class="btn danger" :disabled="disabled" @click="unlink">{{ confirming === 'replace' ? 'Unlink and replace' : 'Unlink' }}</button>
					<button ref="cancelUnlink" class="btn" @click="cancelConfirm">Cancel</button>
				</span>
			</div>
			<div v-if="duplicate" class="confirm" role="group" aria-label="This file is already uploaded">
				<span>This file is already uploaded as {{ duplicate.label }}.</span>
				<ul v-if="duplicate.windows.length" class="wins" role="list" aria-label="Run windows already on that log">
					<li v-for="w in duplicate.windows" :key="w" class="fd-dim win">{{ w }}</li>
				</ul>
				<span v-if="duplicate.note" class="d1-note warn msg">{{ duplicate.note }}</span>
				<span>Use that log for this run?</span>
				<span class="row">
					<button class="btn" :disabled="disabled" @click="useDuplicate">Use that log</button>
					<button ref="cancelDuplicate" class="btn" @click="duplicate = null">Cancel</button>
				</span>
			</div>
		</div>
		<ul v-if="picking && editable" class="pick" role="list" aria-label="Logs already uploaded">
			<li v-if="working && !candidates" class="fd-dim empty">Looking for logs…</li>
			<li v-else-if="!candidates?.length" class="fd-dim empty">{{ profile.linkExisting?.emptyText(detail) }}</li>
			<li v-for="c in candidates" :key="c.id">
				<button class="cand" :disabled="disabled" @click="link(c.id)">
					<span>{{ c.label }}</span>
					<span v-for="w in c.windows" :key="w" class="fd-dim win">{{ w }}</span>
					<span v-if="c.note" class="d1-note warn msg">{{ c.note }}</span>
				</button>
			</li>
		</ul>
		<div v-if="working" class="fd-spin"><v-progress-circular indeterminate small /> working…</div>
		<div v-if="error" class="d1-note bad msg" role="alert">{{ error }}</div>
		<div v-if="notice" class="d1-note warn msg" role="status">{{ notice }}</div>
	</div>
</template>

<style scoped>
.act { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--fd-line); }
.head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: var(--fs-sm, 12px); }
.head .fd-dim { font-variant-numeric: tabular-nums; }
.btns { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
/* the kit's IndexActions .btn: 30px, 8px radius, tile ground, foreground text, accent border on hover (these sit on the panel's surface) */
.btn {
	display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: 30px; padding: 4px 12px;
	border: 1px solid var(--fd-line); border-radius: 8px; background: var(--fd-tile); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; text-align: center; white-space: normal; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--fd-accent); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn:focus-visible { outline: 2px solid var(--fd-accent); outline-offset: 1px; }
.btn.danger { color: var(--d1-bad, var(--theme--danger)); border-color: var(--d1-bad, var(--theme--danger)); }
.btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--d1-bad, var(--theme--danger)) 12%, var(--fd-tile)); border-color: var(--d1-bad, var(--theme--danger)); }
.btn.stack { flex-direction: column; gap: 0; }
.vt { font-weight: 400; font-variant-numeric: tabular-nums; }
.file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
label.btn { position: relative; }
label.btn:focus-within { outline: 2px solid var(--fd-accent); outline-offset: 1px; }
label.btn.off { opacity: 0.45; cursor: default; }
.slot { display: flex; flex-direction: column; gap: 8px; }
.slot:empty { display: none; }
.confirm { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border: 1px solid var(--fd-line); border-radius: 8px; background: var(--fd-tile); font-size: var(--fs-sm, 12px); }
.confirm .row { display: flex; gap: 6px; flex-wrap: wrap; }
.wins { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.win { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.pick { display: flex; flex-direction: column; max-height: 200px; margin: 0; padding: 0; list-style: none; overflow-y: auto; border: 1px solid var(--fd-line); border-radius: 8px; font-size: var(--fs-sm, 12px); }
.pick .empty { padding: 8px 12px; }
.pick li { border-bottom: 1px solid var(--fd-line); }
.pick li:last-child { border-bottom: 0; }
.cand { display: flex; flex-direction: column; gap: 2px; width: 100%; box-sizing: border-box; min-height: 30px; text-align: left; padding: 6px 12px; font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; overflow-wrap: anywhere; }
.cand:hover:not(:disabled) { background: var(--fd-tile); }
.cand:focus-visible { outline: 2px solid var(--fd-accent); outline-offset: -2px; }
.cand:disabled { opacity: 0.45; cursor: default; }
.msg { margin: 0; font-size: var(--fs-sm, 12px); overflow-wrap: anywhere; }
/* the kit's notes (.d1-note) when the page is not inside the kit's frame: error ink and warning ink, never the raw theme fills */
.d1-note.bad { color: var(--d1-bad, var(--theme--danger)); }
.d1-note.warn { color: var(--d1-warn, color-mix(in srgb, var(--theme--warning) 60%, var(--theme--foreground))); }
/* phones: touch targets of at least 40px */
@container (max-width: 700px) {
	.btn { min-height: 40px; }
	.cand { min-height: 40px; }
}
</style>
