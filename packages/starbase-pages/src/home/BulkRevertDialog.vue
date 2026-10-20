<script setup lang="ts">
// The confirm dialog of Revert (admin Home, Bulk actions): what will be put back, the cautions (records changed since are skipped, a revert cannot be
// reverted), then, once it has run, what happened to each record. Same conventions as the kit's BulkDialog: a backdrop (a click on it closes), Escape
// closes, Tab cycles inside, focus goes to Cancel on opening (a destructive step starts on the safe button) and is handed back when it closes, however it
// closes. Errors are role="alert". Teleported to <body>, so it wears d1-kit for the --d1-* tokens. The state lives in useAdminBulk; this draws it.
import { computed, nextTick, ref, watch } from 'vue';
import { revertConfirm, revertLines, revertSummary } from '@d1/ui';
import type { AdminBulkState, BulkActionSummary } from '@d1/ui';

const props = defineProps<{
	bulk: AdminBulkState;
	/** The journal lines by id, so a revert of a revert-able line can name its original. */
	byId: ReadonlyMap<string, BulkActionSummary>;
	/** Called after the dialog closes: hands focus back to the Revert button (or the panel when that button is gone). */
	restoreFocus: () => void;
}>();

const uid = `d1-revert-${Math.random().toString(36).slice(2, 8)}`;
const dialog = ref<HTMLElement | null>(null);
const cancel = ref<HTMLButtonElement | null>(null);

const state = computed(() => props.bulk.revert);
const confirm = computed(() => (state.value ? revertConfirm(state.value.action, props.byId) : null));
const result = computed(() => state.value?.result ?? null);
const lines = computed(() => (result.value ? revertLines(result.value.results) : []));
const summary = computed(() => (result.value && state.value ? revertSummary(result.value.results, state.value.action.collection) : ''));

watch(
	() => !!state.value,
	async (open, was) => {
		if (open) {
			await nextTick();
			cancel.value?.focus();
		} else if (was) {
			await nextTick();
			props.restoreFocus();
		}
	},
	{ immediate: true, flush: 'post' },
);

// While the revert runs its buttons are disabled, and when it ends the Revert button is gone: keep focus inside, on the dialog while it runs and on Close
// once the result is there (after a failure the buttons come back and the person stays where they were).
watch(
	() => [state.value?.busy, !!result.value] as const,
	async ([busy, done]) => {
		if (!state.value) return;
		if (busy) dialog.value?.focus();
		else if (done) {
			await nextTick();
			cancel.value?.focus();
		}
	},
	{ flush: 'post' },
);

function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		props.bulk.closeRevert();
	} else if (e.key === 'Tab') {
		const stops = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
		if (!stops.length) return;
		const first = stops[0];
		const last = stops[stops.length - 1];
		const at = document.activeElement as HTMLElement | null;
		if (e.shiftKey && (at === first || at === dialog.value || !dialog.value?.contains(at))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (at === last || !dialog.value?.contains(at))) {
			e.preventDefault();
			first.focus();
		}
	}
}
</script>

<template>
	<Teleport to="body">
		<div v-if="state && confirm" class="d1-kit rv-backdrop" @mousedown.self="bulk.closeRevert()">
			<div ref="dialog" class="rv" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="`${uid}-title`" @keydown="onKeydown">
				<header class="top">
					<h2 :id="`${uid}-title`">{{ result ? 'Revert finished' : confirm.title }}</h2>
					<button type="button" class="x" aria-label="Close" :disabled="state.busy" @click="bulk.closeRevert()">&times;</button>
				</header>

				<div class="body">
					<template v-if="!result">
						<p class="what">{{ confirm.paragraphs[0] }}</p>
						<p>{{ confirm.paragraphs[1] }}</p>
						<p class="warn">{{ confirm.paragraphs[2] }}</p>
						<p class="hint">{{ confirm.paragraphs[3] }}</p>
					</template>
					<div v-else role="status" class="result">
						<p class="what">{{ summary }}</p>
						<ul class="lines">
							<li v-for="l in lines" :key="l.key">
								<span class="code">{{ l.code }}</span>
								<span class="tag" :class="l.result.tone">{{ l.result.label }}</span>
								<span v-if="l.reason" class="reason">{{ l.reason }}</span>
							</li>
						</ul>
					</div>
					<p v-if="state.busy" class="hint" role="status">Putting the records back…</p>
					<p v-if="state.error" class="err" role="alert">{{ state.error }}</p>
				</div>

				<footer class="foot">
					<span class="grow" />
					<button v-if="!result" ref="cancel" type="button" class="btn" :disabled="state.busy" @click="bulk.closeRevert()">Cancel</button>
					<button v-if="!result" type="button" class="btn danger" :disabled="state.busy" @click="bulk.confirmRevert()">{{ state.busy ? 'Reverting…' : confirm.confirm }}</button>
					<button v-else ref="cancel" type="button" class="btn primary" @click="bulk.closeRevert()">Close</button>
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
/* The dialogs and drawers band of DESIGN.md (100); toasts sit above at 1000. */
.rv-backdrop {
	position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
	background: rgba(0, 0, 0, 0.4); font-family: var(--theme--fonts--sans--font-family, inherit); color: var(--theme--foreground);
}
.rv {
	width: min(520px, 100%); max-height: 84vh; display: flex; flex-direction: column;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius); background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); overflow: hidden;
}
.rv:focus { outline: none; }
.top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--d1-line); }
.top h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-lg, 15px); font-weight: 600; overflow-wrap: anywhere; }
.x { border: 0; background: transparent; color: inherit; font-size: var(--fs-2xl, 22px); line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover:not(:disabled) { background: var(--d1-tile); }
.x:disabled { opacity: 0.55; cursor: default; }
.body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.body p { margin: 0; font-size: var(--fs-md, 13px); overflow-wrap: anywhere; }
.what { font-weight: 600; }
.warn { color: var(--d1-warn); }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { color: var(--d1-bad); }
.result { display: flex; flex-direction: column; gap: 8px; }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; font-size: var(--fs-sm, 12px); }
.lines li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.code { font-weight: 600; }
.reason { color: var(--d1-dim); overflow-wrap: anywhere; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; white-space: nowrap; border: 1px solid var(--d1-line); background: var(--d1-tile); }
.tag.ok { color: var(--d1-ok); }
.tag.dim { color: var(--d1-dim); }
.tag.warn { color: var(--d1-warn); }
.tag.bad { color: var(--d1-bad); }
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--d1-line); }
.grow { flex: 1; }
.btn {
	height: 32px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent); }
.btn.danger { border-color: var(--d1-bad); color: var(--d1-bad); }
.btn.danger:hover:not(:disabled) { border-color: var(--d1-bad); background: color-mix(in srgb, var(--d1-bad) 10%, transparent); }
.btn:disabled { opacity: 0.55; cursor: default; }
button:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
