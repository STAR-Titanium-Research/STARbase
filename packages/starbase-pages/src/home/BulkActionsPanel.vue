<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
	Section, actorText, canRevert, countsText, detailLines, headline, linesById, stateBadge, useAdminBulk, useExplorerHost, whenText, whenTitle,
} from '@d1/ui';
import type { BulkActionSummary } from '@d1/ui';
import BulkActionRows from './BulkActionRows.vue';
import BulkRevertDialog from './BulkRevertDialog.vue';

// Admin Home, "Bulk actions" (spec 1): the journal of every bulk action, newest first: what was done in plain words, by whom, when, the counts and a state
// badge. A line opens to list its records (what happened to each and what a revert did), and an action that is applied or partly reverted (and is not itself
// a revert) has a Revert button that opens a confirm dialog and reports each record. Paged with Show more. `active` is the server-confirmed admin flag
// (home.vue's adminConfirmed): a member or a Lab Viewer never reaches the endpoint and sees nothing, not even a title. The state is useAdminBulk's.
const props = defineProps<{ active: boolean }>();
const api = useExplorerHost().api;
const bulk = reactive(useAdminBulk({ api, active: computed(() => props.active) }));

// The "x ago" texts move on with the clock on a slow tick that runs for admins only, and not while the tab is hidden.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
watch(
	() => props.active,
	(on) => {
		if (tick) clearInterval(tick);
		now.value = Date.now();
		tick = on ? setInterval(() => { if (!document.hidden) now.value = Date.now(); }, 30_000) : null;
	},
	{ immediate: true },
);
onBeforeUnmount(() => { if (tick) clearInterval(tick); });

const byId = computed(() => linesById(bulk.actions));
const rows = computed(() => bulk.actions.map((a) => ({
	a,
	words: headline(a, byId.value),
	badge: stateBadge(a),
	counts: countsText(a),
	who: actorText(a),
	when: whenText(a, now.value),
	whenTitle: whenTitle(a.created_at),
	revertible: canRevert(a),
	detail: bulk.details[a.action_id] ?? null,
})));

// Focus after the dialog: the Revert button that opened it, or the panel when that button is gone (a reverted action offers none).
const root = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
function openRevert(a: BulkActionSummary, e: MouseEvent): void {
	opener = e.currentTarget as HTMLElement;
	bulk.openRevert(a);
}
function restoreFocus(): void {
	const target = opener && document.body.contains(opener) ? opener : root.value;
	opener = null;
	target?.focus();
}
const lines = (r: (typeof rows.value)[number]) => (r.detail?.rows ? detailLines(r.a, r.detail.rows) : null);
</script>

<template>
	<div v-if="active" ref="root" class="bulk-admin" tabindex="-1">
		<Section title="Bulk actions" :count="bulk.loaded && !bulk.hasMore ? bulk.actions.length : null">
			<template #actions>
				<button type="button" class="link" :disabled="bulk.loading" @click="bulk.load()">{{ bulk.loading ? 'Loading…' : 'Reload' }}</button>
			</template>

			<p v-if="bulk.loading && !bulk.loaded" class="d1-note" role="status">Loading the bulk actions…</p>
			<p v-if="bulk.error" class="d1-note bad" role="alert">{{ bulk.error }}</p>
			<p v-else-if="bulk.loaded && !rows.length" class="status"><span class="dot" /> No bulk action has been run yet.</p>

			<ul v-if="rows.length" class="list" aria-label="Bulk actions, newest first">
				<li v-for="r in rows" :key="r.a.action_id" class="action">
					<div class="head">
						<button
							type="button" class="toggle" :aria-expanded="!!r.detail?.open" :aria-controls="`bulk-rows-${r.a.action_id}`" @click="bulk.toggle(r.a.action_id)"
						>
							<span class="caret" aria-hidden="true">{{ r.detail?.open ? '▾' : '▸' }}</span>
							<span class="words">{{ r.words }}</span>
						</button>
						<span class="badge" :class="r.badge.tone">{{ r.badge.label }}</span>
						<button v-if="r.revertible" type="button" class="btn" :aria-label="`Revert: ${r.words}`" @click="openRevert(r.a, $event)">Revert</button>
					</div>
					<p class="meta">
						<span>{{ r.who }}</span>
						<span v-if="r.when" :title="r.whenTitle">{{ r.when }}</span>
						<span>{{ r.counts }}</span>
					</p>
					<div v-if="r.detail?.open" :id="`bulk-rows-${r.a.action_id}`" class="detail">
						<BulkActionRows
							:lines="lines(r)" :loading="r.detail.loading" :error="r.detail.error" :is-revert="!!r.a.revert_of" @retry="bulk.retryRows(r.a.action_id)"
						/>
					</div>
				</li>
			</ul>

			<p v-if="bulk.hasMore" class="more">
				<button type="button" class="btn" :disabled="bulk.loadingMore" @click="bulk.more()">{{ bulk.loadingMore ? 'Loading…' : 'Show more' }}</button>
			</p>
		</Section>
		<BulkRevertDialog :bulk="bulk" :by-id="byId" :restore-focus="restoreFocus" />
	</div>
</template>

<style scoped>
.bulk-admin { margin-top: 16px; min-width: 0; }
.bulk-admin:focus { outline: none; }
.link {
	border: 0; background: transparent; padding: 2px 4px; border-radius: 6px; color: var(--d1-accent, var(--theme--primary)); font: inherit; font-weight: 600;
	font-size: var(--fs-sm, 12px); cursor: pointer; white-space: nowrap;
}
.link:hover:not(:disabled) { text-decoration: underline; }
.link:disabled { opacity: 0.55; cursor: default; }
.status { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--fs-md, 13px); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--d1-dim); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.action { padding: 8px 12px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); min-width: 0; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.toggle {
	flex: 1 1 14em; min-width: 0; display: flex; align-items: baseline; gap: 6px; padding: 2px 4px; margin: -2px -4px; border: 0; border-radius: 6px; background: transparent;
	color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; text-align: left; cursor: pointer;
}
.toggle:hover .words { text-decoration: underline; }
.caret { flex: none; width: 1em; color: var(--d1-dim); }
.words { min-width: 0; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 0 0 1.4em; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.detail { margin: 8px 0 2px 1.4em; min-width: 0; }
.badge { padding: 1px 8px; border: 1px solid var(--d1-line); border-radius: 99px; background: var(--d1-surface); font-size: var(--fs-xs, 11px); font-weight: 700; white-space: nowrap; }
.badge.ok { color: var(--d1-ok); }
.badge.dim { color: var(--d1-dim); }
.badge.warn { color: var(--d1-warn); }
.badge.bad { color: var(--d1-bad); }
.more { margin: 10px 0 0; }
.btn {
	height: 28px; padding: 0 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn:disabled { opacity: 0.55; cursor: default; }
button:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
