<script setup lang="ts">
// "?" overlay for the Plot dashboard: the gestures that are not visible on screen. A modal dialog:
// Escape closes it, Tab stays inside it, and focus goes back to whatever opened it. Host-agnostic
// (no host imports) and styled like InfoTip's bubble so it reads as the same family of help.
import { ref } from 'vue';
import { PLOT_HELP } from './plotHelp';
import { useModalFocus } from './modalFocus';

const emit = defineEmits<{ (e: 'close'): void }>();
const rootEl = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
useModalFocus(rootEl, { onEscape: () => emit('close'), initialFocus: () => closeBtn.value?.focus() });
</script>

<template>
	<div class="ph-scrim" @pointerdown.self="emit('close')">
		<div ref="rootEl" class="ph-card" role="dialog" aria-modal="true" aria-labelledby="ph-title">
			<div class="ph-head">
				<strong id="ph-title">Plot gestures</strong>
				<button ref="closeBtn" type="button" class="ph-close" aria-label="Close help" @click="emit('close')">×</button>
			</div>
			<div class="ph-body">
				<section v-for="s in PLOT_HELP" :key="s.title" class="ph-sec">
					<h4>{{ s.title }}</h4>
					<dl>
						<template v-for="g in s.items" :key="g.gesture">
							<dt>{{ g.gesture }}</dt>
							<dd>{{ g.does }}</dd>
						</template>
					</dl>
				</section>
			</div>
		</div>
	</div>
</template>

<style scoped>
.ph-scrim {
	position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center;
	padding: 16px; background: rgba(2, 6, 23, 0.5);
}
.ph-card {
	width: min(560px, 100%); max-height: min(80vh, 640px); display: flex; flex-direction: column;
	background: var(--bg-1, var(--theme--background, #0f172a)); color: var(--text, var(--theme--foreground, #e5e7eb));
	border: 1px solid var(--border, var(--theme--border-color-subdued, rgba(255,255,255,0.16))); border-radius: 10px;
	box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); font-size: var(--fs-xs, 11px); line-height: 1.45;
}
.ph-head {
	display: flex; align-items: center; justify-content: space-between; padding: 10px 14px;
	border-bottom: 1px solid var(--border, var(--theme--border-color-subdued, rgba(255,255,255,0.16)));
	color: var(--accent, #7dd3fc); font-size: var(--fs-md, 13px);
}
.ph-close {
	font: inherit; font-size: 18px; line-height: 1; color: inherit; cursor: pointer; background: transparent;
	border: 0; border-radius: 6px; padding: 2px 8px;
}
.ph-close:hover, .ph-close:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #38bdf8) 50%, transparent); }
.ph-body { overflow: auto; padding: 6px 14px 14px; }
.ph-sec h4 { margin: 12px 0 4px; color: var(--accent, #7dd3fc); font-weight: 650; font-size: var(--fs-xs, 11px); }
.ph-sec dl { margin: 0; display: grid; grid-template-columns: minmax(110px, 30%) 1fr; gap: 4px 12px; }
.ph-sec dt { font-weight: 600; }
.ph-sec dd { margin: 0; color: var(--text-dim, var(--theme--foreground-subdued, #94a3b8)); }
</style>
