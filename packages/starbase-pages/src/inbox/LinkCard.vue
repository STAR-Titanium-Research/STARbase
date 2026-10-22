<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { AppLink } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { changeBlocked, linkCardView, undoConfirmText } from './linkedModel';

// The Link card (the maintainer's pick A): where a linked file went, by whom and when, with Open (the record's page), Change… (the Link dialog, the page's) and
// Undo link (an inline confirm that says how many files the undo takes with it: a batch is undone whole); the last two only when the server says the caller may
// undo this link (can_undo: the person who linked it). An unlinked file shows nothing. It only reports what
// was asked; the sheet, the view box's left panel and the view box page each do it through the same Inbox actions, so a refusal shows in their notice.
const props = defineProps<{
	file: FoundFile;
	/** A change or an undo is running: nothing more can be pressed. */
	busy: boolean;
}>();
const emit = defineEmits<{
	(e: 'open', route: string): void;
	(e: 'change'): void;
	(e: 'undo'): void;
}>();

const view = computed(() => linkCardView(props.file));
const blocked = computed(() => (view.value ? changeBlocked(view.value) : null));
const undoText = computed(() => (view.value ? undoConfirmText(view.value) : ''));

// ---- the inline confirm: Cancel has the focus when it opens, the Undo link button gets it back when it closes (or the undo ends) ----
const confirming = ref(false);
const undoBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
watch(confirming, (open) => {
	if (open) void nextTick(() => cancelBtn.value?.focus());
});
function cancel(): void {
	confirming.value = false;
	void nextTick(() => undoBtn.value?.focus());
}
// the undo ran (the card goes with the file) or was refused (its words are in the page's notice): the confirm is done either way
watch(
	() => props.busy,
	(now, before) => {
		if (before && !now) cancel();
	},
);
</script>

<template>
	<section v-if="view" class="link-card" aria-label="Where this file is linked" data-test="link-card">
		<div class="top">
			<span class="ico" aria-hidden="true"><v-icon name="link" small /></span>
			<div class="what">
				<p class="head" data-test="link-head">
					<span class="lead">{{ view.lead }}</span>{{ ' ' }}
					<AppLink v-if="view.route && view.code" :to="view.route" class="rec" data-test="link-code">{{ view.code }}</AppLink>
					<span v-else class="rec" :class="{ off: !view.code }" data-test="link-code">{{ view.code ?? 'a record you cannot open' }}</span>
				</p>
				<p v-if="view.meta" class="meta" data-test="link-meta">{{ view.meta }}</p>
			</div>
		</div>
		<div class="row">
			<button v-if="view.route" type="button" class="d1-btn pri" data-test="link-open" @click="emit('open', view.route)">{{ view.openLabel }}</button>
			<button v-if="!view.scan && view.canUndo" type="button" class="d1-btn" :disabled="busy || !!blocked" :aria-describedby="blocked ? 'link-change-why' : undefined" data-test="link-change" @click="emit('change')">Change…</button>
			<button v-if="view.canUndo" ref="undoBtn" type="button" class="d1-btn" :disabled="busy || confirming" data-test="link-undo" @click="confirming = true">Undo link</button>
		</div>
		<p v-if="blocked && !view.scan && view.canUndo" id="link-change-why" class="hint" data-test="link-change-why">{{ blocked }}</p>
		<!-- the live region is always in the page, so a confirm that opens in it is announced -->
		<div class="slot" aria-live="polite">
			<div v-if="confirming" class="confirm" role="group" aria-label="Undo this link" data-test="link-confirm" @keydown.esc.stop.prevent="cancel">
				<span>{{ undoText }}</span>
				<span class="row">
					<button type="button" class="d1-btn danger" :disabled="busy" data-test="link-undo-yes" @click="emit('undo')">Undo link</button>
					<button ref="cancelBtn" type="button" class="d1-btn" data-test="link-undo-cancel" @click="cancel">Cancel</button>
				</span>
			</div>
		</div>
	</section>
</template>

<style scoped>
.link-card {
	box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; min-width: 0;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile, var(--theme--background-subdued)); color: var(--theme--foreground);
	font-size: var(--fs-md, 13px); line-height: 1.45;
}
.top { display: flex; align-items: flex-start; gap: 8px; }
.ico { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--d1-tint); color: var(--d1-accent, var(--theme--primary)); }
.what { min-width: 0; }
.head { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
/* record codes are mono, bold and dotted-underlined links (DESIGN.md sections 3 and 7) */
.rec { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline dotted; }
.rec.off { font-family: inherit; font-weight: 600; text-decoration: none; color: var(--d1-dim); }
.meta { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 6px; }
.hint { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.slot:empty { display: none; }
.confirm { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--d1-line); font-size: var(--fs-sm, 12px); }
</style>
