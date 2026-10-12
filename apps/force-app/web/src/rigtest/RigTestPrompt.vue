<script setup lang="ts">
// "Your admin has requested tests on this rig": the consent dialog. Shown on every page (mounted
// through RigTestHost in AppShell) unless a cut is being recorded or saved, when promptMode()
// says "badge" and only the sidebar shows anything: a dialog must never cover the Record page
// mid-cut. One request at a time, oldest first. There is no Escape and no click-away: the
// operator answers (Run now / Snooze / Decline), so a request is never dismissed by accident.
import { computed, ref } from 'vue';
import { useDialog } from '../ui/useDialog';
import RigTestRequestCard from './RigTestRequestCard.vue';
import { rigTest } from './rigTestStore';

const panel = ref<HTMLElement | null>(null);
const show = computed(() => rigTest.mode.value === 'dialog' && !!rigTest.head.value);
const waiting = computed(() => rigTest.state.pending.length - 1);
useDialog(panel);
</script>

<template>
	<transition name="rt-fade">
		<div v-if="show" class="rt-backdrop" data-testid="rig-test-prompt">
			<div ref="panel" class="rt-panel dialog-in" role="dialog" aria-modal="true" aria-labelledby="rt-prompt-title" tabindex="-1">
				<header class="rt-head">
					<span class="material-symbols-rounded rt-icon">science</span>
					<h2 id="rt-prompt-title">Your admin has requested tests on this rig</h2>
				</header>
				<RigTestRequestCard :request="rigTest.head.value!" :key="rigTest.head.value!.number" />
				<p v-if="waiting > 0" class="rt-more">{{ waiting }} more {{ waiting === 1 ? 'request is' : 'requests are' }} waiting; they are offered one at a time.</p>
			</div>
		</div>
	</transition>
</template>

<style scoped>
/* z-index 190: above the page, the recording banner (150) and the update prompt (180), and below
   the recording Save dialog (200), the other dialogs, the alarm banner (290) and the confirm prompt
   (300). z-order.test.ts pins this: the prompt never sits on top of an open Save dialog. */
.rt-backdrop { position: fixed; inset: 0; z-index: 190; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--overlay); backdrop-filter: blur(2px); }
.rt-panel { width: min(520px, 100%); max-height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 20px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); outline: none; }
.rt-head { display: flex; align-items: center; gap: 10px; }
.rt-head h2 { margin: 0; font-size: var(--fs-xl); line-height: 1.25; }
.rt-icon { font-size: var(--icon-xl); color: var(--accent); }
.rt-more { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.rt-fade-enter-active, .rt-fade-leave-active { transition: opacity 0.12s ease; }
.rt-fade-enter-from, .rt-fade-leave-to { opacity: 0; }
</style>
