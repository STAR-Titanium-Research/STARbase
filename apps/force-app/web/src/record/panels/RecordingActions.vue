<script setup lang="ts">
// Start/Stop (sim/nidaq) or the TransportBar (replay) — split out of RecordingOptions.vue so
// RecordPage.vue can hand it to PanelFrame's #footer slot and pin it to the bottom of the panel,
// always visible without scrolling past the metadata form.
import { computed, ref } from 'vue';
import { isMacPlatform, shortcutHints } from '../shortcuts';
import { useRouter } from 'vue-router';
import { useWorkspace } from '../workspace';
import { attentionItems, type PreflightItem, type PreflightLevel } from '../preflight';
import TransportBar from './TransportBar.vue';
import { describeRecordingFailure, FIELD_FOCUS } from '../recordingErrors';
import { spotlight } from '../../ui/spotlight';

const w = useWorkspace();

// R10: the shortcut list under Start. Cmd on a Mac, Ctrl elsewhere.
const hints = shortcutHints(isMacPlatform());
const startKeys = hints[0].keys;
const stopKeys = hints[1].keys;
const hintsOpen = ref(false);

// #84: a rate the assigned NI-DAQ modules can't do is caught here, before Start, instead of as a
// driver error after a session (and a capture directory) already exists. Start stays disabled
// until it is fixed; "Show me" points at the tile.
function showSampleRate() { spotlight(FIELD_FOCUS.sample_rate); }
// R4: the pre-Start checklist. Chips show every item at a glance; anything warning or failing also
// gets a line with "Show me", which rings the control (or opens the page that owns it).
const router = useRouter();
const attention = computed(() => attentionItems(w.preflight.value));
const LEVEL_ICON: Record<PreflightLevel, string> = {
	ok: 'check_circle', info: 'info', warn: 'warning', fail: 'error', skip: 'radio_button_unchecked',
};
function showMe(it: PreflightItem) {
	const f = it.focus;
	if (!f) return;
	if (f.route) void router.push({ path: f.route, query: { focus: f.id } });
	else spotlight(f.id);
}
// A failed run's line under Start: the plain-language summary, not the first line of a traceback.
const failure = computed(() => (w.st.state === 'error' && w.st.error
	? describeRecordingFailure(w.st.error, w.st.errorKind, w.st.nTotal)
	: null));
</script>

<template>
	<div class="actions-wrap">
		<TransportBar v-if="w.mode.value === 'playback'" />
		<div v-else class="actions-row">
			<!-- Acquisition's processing toggles: moved here from a Details card so they're checked
				 in the moment right before Start, not folded away. Bound to w.recordingPrefs, the
				 persisted singleton shared with Settings > Recording — not w.cfg/w.converge, which
				 only carry per-session/transient state now (see recordingPrefs.ts). -->
			<div v-if="w.source.value !== 'replay'" class="segproc">
				<button type="button" :class="{ on: w.recordingPrefs.frmFromCut }" :disabled="w.locked.value"
					title="Detect cut start — live FRM begins at the cut" @click="w.recordingPrefs.frmFromCut = !w.recordingPrefs.frmFromCut">
					<span class="material-symbols-rounded">flag</span>Cut start
				</button>
				<button type="button" :class="{ on: w.recordingPrefs.driftComp }" :disabled="w.locked.value"
					title="Drift compensation — saved outputs only, raw stays raw" @click="w.recordingPrefs.driftComp = !w.recordingPrefs.driftComp">
					<span class="material-symbols-rounded">compare_arrows</span>Drift
				</button>
				<button type="button" :class="{ on: w.recordingPrefs.convergeEnabled }" :disabled="w.locked.value"
					title="Converging auto-range — tune per-channel ranges between cuts" @click="w.recordingPrefs.convergeEnabled = !w.recordingPrefs.convergeEnabled">
					<span class="material-symbols-rounded">tune</span>Converge
				</button>
			</div>
			<div class="actions">
				<button v-if="!w.locked.value" class="btn success start" :disabled="w.startDisabled.value"
					:title="w.sampleRateBlocker.value || `Start (${startKeys})`" @click="w.requestStart()">
					<span class="material-symbols-rounded">fiber_manual_record</span> Start
				</button>
				<button v-else class="btn danger stop" :disabled="w.stopDisabled.value" :title="`Stop (${stopKeys})`" @click="w.stop()">
					<span class="material-symbols-rounded">stop</span> {{ w.isFinalizing.value ? 'Finalizing…' : 'Stop' }}
				</button>
				<button v-if="w.isDone.value" class="btn" @click="w.newRun()">New</button>
			</div>
		</div>
		<div v-if="w.mode.value !== 'playback'" class="kbd-hint">
			<button type="button" class="linkbtn" :aria-expanded="hintsOpen" aria-controls="kbd-list" data-testid="shortcuts-toggle" @click="hintsOpen = !hintsOpen">Keyboard shortcuts</button>
			<span v-if="!hintsOpen" class="kbd-short">{{ startKeys }} start, {{ stopKeys }} stop</span>
			<ul v-if="hintsOpen" id="kbd-list" class="kbd-list" data-testid="shortcuts-list">
				<li v-for="h in hints" :key="h.keys + h.label"><kbd>{{ h.keys }}</kbd> {{ h.label }}</li>
			</ul>
		</div>
		<div v-if="w.mode.value !== 'playback' && w.source.value !== 'replay'" class="proc-notes">
			<p v-if="w.recordingPrefs.convergeEnabled && w.source.value !== 'nidaq'" class="hint">Applies live only with the NI-DAQ source; on sim/replay it just previews the recommendation.</p>
			<p v-if="w.converge.status" class="sync" :class="w.converge.busy ? 'warn' : 'ok'"><span class="material-symbols-rounded">tune</span>{{ w.converge.status }}</p>
		</div>
		<!-- R4: pre-flight. Chips for every item (tooltip = the detail), then one line per problem. -->
		<div v-if="!w.locked.value && w.preflight.value.length" class="preflight" data-testid="preflight">
			<ul class="pf-chips" aria-label="Pre-flight checks">
				<li v-for="it in w.preflight.value" :key="it.id" class="pf-chip" :class="it.level" :title="it.detail" :data-testid="`preflight-${it.id}`">
					<span class="material-symbols-rounded">{{ LEVEL_ICON[it.level] }}</span>{{ it.label }}
				</li>
			</ul>
			<p v-for="it in attention" :key="it.id" class="pf-line" :class="it.level">
				{{ it.detail }}
				<button v-if="it.focus" type="button" class="linkbtn" @click="showMe(it)">Show me</button>
			</p>
			<p v-if="w.sampleConfirmOpen.value" class="pf-confirm" role="alert" data-testid="preflight-sample-confirm">
				<span>Start without a Sample?</span>
				<button type="button" class="btn sm" data-testid="start-anyway" @click="w.startAnyway()">Start anyway</button>
			</p>
		</div>
		<p v-if="w.sampleRateBlocker.value && !w.locked.value" class="err">
			{{ w.sampleRateBlocker.value }} <button type="button" class="linkbtn" @click="showSampleRate">Show me</button>
		</p>
		<p v-if="w.errMsg.value" class="err">{{ w.errMsg.value }}</p>
		<p v-if="failure" class="err" :title="failure.details">{{ failure.summary }}</p>
	</div>
</template>

<style scoped>
.actions-wrap { display: flex; flex-direction: column; gap: 4px; }
/* One row while the toggles and Start fit side by side. When they don't (the default narrow
   column), Start wraps onto a full-width row of its own instead of the toggles being squeezed
   until their labels clip. The 999:1 grow split keeps Start at its natural width while the two
   share a row; alone on its row it takes the whole width. */
.actions-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.actions { flex: 1 0 auto; display: flex; justify-content: flex-end; gap: 8px; }
.actions .btn { flex: 1 0 auto; justify-content: center; }
/* Acquisition's processing toggles — relocated from a Details card (see RecordingOptions.vue). */
.segproc { flex: 999 0 auto; display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.segproc button { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px; background: var(--bg-3); white-space: nowrap; border: none; border-right: 1px solid var(--border); color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; cursor: pointer; }
.segproc button:last-child { border-right: none; }
.segproc button.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.segproc button:disabled { opacity: 0.5; cursor: not-allowed; }
.segproc .material-symbols-rounded { font-size: var(--icon-sm); }
.kbd-hint { margin-top: 2px; font-size: var(--fs-xs); color: var(--text-dim); display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.kbd-hint .linkbtn { font-size: var(--fs-xs); }
.kbd-list { flex-basis: 100%; margin: 2px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.kbd-hint kbd { display: inline-block; min-width: 1.4em; padding: 0 5px; font: inherit; font-weight: 600; text-align: center; color: var(--text); background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; }
.proc-notes { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin: 0; }
.sync { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); margin: 0; }
.sync .material-symbols-rounded { font-size: var(--icon-xs); }
.sync.ok { color: var(--ok); }
.sync.warn { color: var(--warn); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 4px 0 0; }
.preflight { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.pf-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
.pf-chip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px 1px 4px; font-size: var(--fs-xs); border: 1px solid var(--border); border-radius: 10px; color: var(--text-dim); background: var(--surface); }
.pf-chip .material-symbols-rounded { font-size: var(--icon-xs); }
.pf-chip.ok { color: var(--ok); }
.pf-chip.info { color: var(--accent); }
.pf-chip.warn { color: var(--warn); border-color: var(--warn); }
.pf-chip.fail { color: var(--danger); border-color: var(--danger); }
.pf-line { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.pf-line.warn { color: var(--warn); }
.pf-line.fail { color: var(--danger); }
.pf-confirm { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; padding: 4px 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--warn); border: 1px solid var(--warn); border-radius: 8px; }
.linkbtn { padding: 0; border: none; background: none; color: var(--accent); font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
</style>
