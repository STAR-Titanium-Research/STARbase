<script setup lang="ts">
// The minimised run: a bar along the bottom edge, visible on every page, with the run's position
// and time left, a way back to the modal and Cancel (confirmed). A question that is waiting for
// the operator is flagged here; the modal reopens by itself when a NEW one arrives, but one the
// operator minimised on purpose stays minimised.
import { computed } from 'vue';
import { confirmAndCancelRun } from './confirmCancel';
import { rigTest } from './rigTestStore';
import { barAskText, minimisedText } from './rigTestLogic';

const run = computed(() => rigTest.state.run);
</script>

<template>
	<div v-if="run" class="rb-bar" :class="{ asking: !!run.question }" role="region" aria-label="Rig test in progress" data-testid="rig-test-bar">
		<span class="rb-dot" aria-hidden="true"></span>
		<span class="rb-text">{{ minimisedText(run) }}</span>
		<span v-if="run.question" class="rb-ask">{{ barAskText(rigTest.runBlocked.value) }}</span>
		<span class="rb-spacer"></span>
		<button type="button" class="btn sm" @click="rigTest.restore()">
			<span class="material-symbols-rounded">open_in_full</span>Show
		</button>
		<button type="button" class="btn sm danger quiet" @click="confirmAndCancelRun">Cancel</button>
	</div>
</template>

<style scoped>
/* z-index 185: above the update prompt (180) that shares this corner, below the recording Save
   dialog (200), the other dialogs and the alarm banner (290). z-order.test.ts pins this. */
.rb-bar { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 185; width: min(900px, calc(100vw - 24px)); height: var(--rig-bar-h, 44px);
	display: flex; align-items: center; gap: 10px; padding: 0 12px; font-size: var(--fs-md); font-weight: 600;
	background: var(--bg-2); border: 1px solid var(--border-2); border-bottom: 0; border-radius: 12px 12px 0 0; box-shadow: 0 -6px 24px rgba(0,0,0,0.3); }
.rb-bar.asking { border-color: var(--accent); }
.rb-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--accent); --pulse-color: var(--accent); animation: live-pulse 1.4s infinite; }
.rb-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rb-ask { flex: 0 0 auto; padding: 2px 8px; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-ink); background: var(--accent); border-radius: 99px; }
.rb-spacer { flex: 1; }
</style>
