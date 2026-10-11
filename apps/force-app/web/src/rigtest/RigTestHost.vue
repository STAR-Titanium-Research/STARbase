<script setup lang="ts">
// The one mount point in AppShell: starts the store's polling for as long as the shell lives, and
// renders whichever of the consent prompt, the run modal or the minimised bar applies. All the
// decisions are in rigTestLogic.ts; this only wires them.
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import RigTestBar from './RigTestBar.vue';
import RigTestPrompt from './RigTestPrompt.vue';
import RigTestRunModal from './RigTestRunModal.vue';
import { rigTest } from './rigTestStore';
import { runView, type RecordingPhase } from './rigTestLogic';

const props = defineProps<{ recordingPhase: RecordingPhase }>();
watch(() => props.recordingPhase, (p) => rigTest.setRecordingPhase(p), { immediate: true });

let stop: (() => void) | null = null;
onMounted(() => { stop = rigTest.start(); });
onBeforeUnmount(() => { stop?.(); stop = null; document.documentElement.style.removeProperty('--rig-bar-h'); });

const view = computed(() => runView(rigTest.state.run, rigTest.state.minimised, !!rigTest.state.finished));
// While the bar is up the page leaves room for it (AppShell's .content reads this).
watch(() => view.value === 'bar', (bar) => {
	if (bar) document.documentElement.style.setProperty('--rig-bar-h', '44px');
	else document.documentElement.style.removeProperty('--rig-bar-h');
}, { immediate: true });
</script>

<template>
	<RigTestPrompt />
	<RigTestRunModal v-if="view === 'modal'" />
	<RigTestBar v-if="view === 'bar'" />
</template>
