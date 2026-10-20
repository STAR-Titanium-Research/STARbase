<script setup lang="ts">
// The toast of an applied bulk action (spec section 1): what was done, an Undo button and a ring that empties over the 60-second window;
// then "Done", or "Undone" if Undo was pressed. Rows the action skipped (or an undo left alone) are folded under "12 skipped".
// Look: CreateToast's card. Layer: the toast band of DESIGN.md (1000), set by BulkToasts.
//
// Screen readers: the status region is mounted empty and filled a moment later (a live region that arrives with its text is often not
// announced); it says the result, then "Done" or "Undone", never the ticking seconds. The ring and the seconds are
// aria-hidden. Under prefers-reduced-motion the ring is drawn full and still, and the seconds left are shown as a number instead.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import BulkSkips from './BulkSkips.vue';
import { leftAsTheyAre, ringFraction, toastAnnouncement } from './bulkModel';
import type { ToastModel } from './bulkModel';

const props = defineProps<{ toast: ToastModel }>();
const emit = defineEmits<{ undo: []; dismiss: [] }>();

const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The ring is set to where it will be a second from now, and eased there linearly, so it empties smoothly between ticks.
const offset = computed(() => CIRCUMFERENCE * (1 - ringFraction(props.toast.left - 1)));

const said = ref('');
// A moment after mounting, not on the next tick: screen readers pick up a region that changes after they have seen it empty.
let fill: ReturnType<typeof setTimeout> | null = null;
onMounted(() => (fill = setTimeout(() => (said.value = toastAnnouncement(props.toast)), 150)));
onBeforeUnmount(() => fill && clearTimeout(fill));
watch(() => toastAnnouncement(props.toast), (text) => (said.value = text));

const headline = computed(() => (props.toast.phase === 'done' ? 'Done' : props.toast.phase === 'undone' ? 'Undone' : props.toast.message));
const rows = computed(() => (props.toast.phase === 'undone' ? props.toast.undoSkipped : props.toast.skipped));
const skipSummary = computed(() => (props.toast.phase === 'undone' ? leftAsTheyAre(rows.value.length) : `${rows.value.length} skipped`));
</script>

<template>
	<div class="d1-kit bulk-toast" :class="props.toast.phase">
		<p class="vh" role="status" aria-live="polite" aria-atomic="true">{{ said }}</p>
		<svg v-if="toast.phase === 'pending'" class="ring" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
			<circle class="track" cx="14" cy="14" :r="RADIUS" fill="none" stroke-width="3" />
			<circle
				class="arc" cx="14" cy="14" :r="RADIUS" fill="none" stroke-width="3" stroke-linecap="round" transform="rotate(-90 14 14)"
				:stroke-dasharray="CIRCUMFERENCE" :stroke-dashoffset="offset"
			/>
		</svg>
		<span v-else class="mark" aria-hidden="true">{{ toast.phase === 'done' ? '✓' : '↶' }}</span>
		<div class="msg">
			<strong>{{ headline }}</strong>
			<span v-if="toast.phase !== 'pending'" class="sub">{{ toast.message }}</span>
			<span v-else class="secs" aria-hidden="true">{{ toast.left }} s left to undo</span>
			<p v-if="toast.error" class="err" role="alert">{{ toast.error }}</p>
			<BulkSkips :summary="skipSummary" :rows="rows" />
		</div>
		<button v-if="toast.phase === 'pending'" type="button" class="undo" :disabled="toast.busy" @click="emit('undo')">{{ toast.busy ? 'Undoing…' : 'Undo' }}</button>
		<button type="button" class="x" aria-label="Dismiss" @click="emit('dismiss')">&times;</button>
	</div>
</template>

<style scoped>
.bulk-toast {
	position: relative; display: flex; align-items: flex-start; gap: 12px; width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 12px 10px 14px;
	border: 1px solid var(--d1-line); border-left: 4px solid var(--d1-ok); border-radius: var(--d1-radius, 12px);
	background: var(--d1-surface); color: var(--theme--foreground); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); font-size: var(--fs-md, 13px);
}
.ring { flex: none; margin-top: 1px; }
.track { stroke: var(--d1-line); }
.arc { stroke: var(--d1-accent, var(--theme--primary)); transition: stroke-dashoffset 1s linear; }
.mark { flex: none; width: 28px; text-align: center; font-size: var(--fs-xl, 18px); line-height: 28px; color: var(--d1-ok); }
.msg { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sub, .secs { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.secs { display: none; }
.err { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.undo {
	flex: none; height: 30px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.undo:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.undo:disabled { opacity: 0.55; cursor: default; }
.x { flex: none; border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover { background: var(--d1-tile); }
button:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.vh { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* The ring is the only motion this adds. Reduced motion: it stays full and still, and the seconds are written out. */
@media (prefers-reduced-motion: reduce) {
	.arc { transition: none; stroke-dashoffset: 0; }
	.secs { display: block; }
}
</style>
