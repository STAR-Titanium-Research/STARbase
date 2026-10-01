<script setup lang="ts">
// Start/Stop (sim/nidaq) or the TransportBar (replay) — split out of RecordingOptions.vue so
// RecordPage.vue can hand it to PanelFrame's #footer slot and pin it to the bottom of the panel,
// always visible without scrolling past the metadata form.
import { useWorkspace } from '../workspace';
import TransportBar from './TransportBar.vue';

const w = useWorkspace();
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
				<button v-if="!w.locked.value" class="btn success start" :disabled="w.busy.value || !w.st.connected" @click="w.start()">
					<span class="material-symbols-rounded">fiber_manual_record</span> Start
				</button>
				<button v-else class="btn danger stop" :disabled="w.busy.value || w.isFinalizing.value" @click="w.stop()">
					<span class="material-symbols-rounded">stop</span> {{ w.isFinalizing.value ? 'Finalizing…' : 'Stop' }}
				</button>
				<button v-if="w.isDone.value" class="btn" @click="w.newRun()">New</button>
			</div>
		</div>
		<div v-if="w.mode.value !== 'playback' && w.source.value !== 'replay'" class="proc-notes">
			<p v-if="w.recordingPrefs.convergeEnabled && w.source.value !== 'nidaq'" class="hint">Applies live only with the NI-DAQ source; on sim/replay it just previews the recommendation.</p>
			<p v-if="w.converge.status" class="sync" :class="w.converge.busy ? 'warn' : 'ok'"><span class="material-symbols-rounded">tune</span>{{ w.converge.status }}</p>
		</div>
		<p v-if="w.errMsg.value" class="err">{{ w.errMsg.value }}</p>
		<p v-if="w.st.state === 'error' && w.st.error" class="err">{{ w.st.error.split('\n')[0] }}</p>
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
.proc-notes { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin: 0; }
.sync { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); margin: 0; }
.sync .material-symbols-rounded { font-size: var(--icon-xs); }
.sync.ok { color: var(--ok); }
.sync.warn { color: var(--warn); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 4px 0 0; }
</style>
