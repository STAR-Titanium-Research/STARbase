<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { AppLink, Section, formatDate, recordRoute, useExplorerHost, useInboxSummary } from '@d1/ui';
import { AUTO_LINK_CONSENT, AUTO_LINK_OFF_NOTE, AUTO_LINK_ON_NOTE, AUTO_LINK_TITLE, groupLinked } from './inboxBulk';
import { nameOf } from './inboxModel';
import { createAutoLink } from './useAutoLink';
import '../settings/settings.css';

// Settings → Inbox (decision D10): the switch that links new pictures for the person, off by default, with the consent text said before it is
// turned on (what is linked, that documents never are, where the undo is), and the "Recently auto-linked" list with an Undo per batch. The
// section is left out when the server has no d1-inbox yet.
const host = useExplorerHost();
const summary = useInboxSummary(host);
const al = createAutoLink(host.api, () => void summary.refresh());

const confirming = ref(false);
const groups = computed(() => groupLinked(al.recent.value).filter((g) => g.batch));

onMounted(() => void al.load());
onBeforeUnmount(() => al.cancel());

// Turning it on goes through the consent dialog; turning it off is one click.
function toggle(el: HTMLInputElement): void {
	if (el.checked) {
		el.checked = false;
		confirming.value = true;
	} else {
		void al.set(false).then(() => (el.checked = al.on.value));
	}
}
async function turnOn() {
	confirming.value = false;
	await al.set(true);
}
const linkTo = (f: { linked_collection?: string | null; linked_record_id?: string | null }) =>
	f.linked_collection && f.linked_record_id ? recordRoute(f.linked_collection, f.linked_record_id) : null;
</script>

<template>
	<Section v-if="!al.absent.value" title="Inbox" data-test="autolink-section">
		<div class="st-rows">
			<div class="st-row">
				<label class="st-check">
					<input type="checkbox" role="switch" :checked="al.on.value" :disabled="al.loading.value || al.saving.value" data-test="autolink-switch" @change="toggle($event.target as HTMLInputElement)" />
					<span class="st-title">{{ AUTO_LINK_TITLE }}</span>
				</label>
				<span v-if="al.error.value" class="st-failed" role="alert">
					{{ al.error.value }}
					<button type="button" class="st-link" @click="al.load()">Retry</button>
				</span>
				<span v-else-if="al.note.value" class="st-status" role="status">{{ al.note.value }}</span>
			</div>
			<div class="consent" data-test="autolink-consent">
				<p class="st-hint now">{{ al.on.value ? AUTO_LINK_ON_NOTE : AUTO_LINK_OFF_NOTE }}</p>
				<p v-for="(p, i) in AUTO_LINK_CONSENT" :key="i" class="st-hint">{{ p }}</p>
			</div>

			<div class="recent" data-test="recently-auto-linked">
				<h3 class="st-title">Recently auto-linked</h3>
				<p v-if="al.recentError.value" class="st-failed" role="alert">{{ al.recentError.value }}</p>
				<p v-if="!groups.length" class="st-hint">Nothing was linked automatically yet.</p>
				<ul v-else class="batches">
					<li v-for="g in groups" :key="g.batch!.id" class="batch">
						<ul class="files">
							<li v-for="f in g.rows" :key="f.candidate_id">
								<span class="fname" :title="f.rel_path">{{ nameOf(f.rel_path) }}</span>
								to
								<AppLink v-if="linkTo(f)" :to="linkTo(f)!" class="rec">{{ f.linked_label || 'a record' }}</AppLink><template v-else>{{ f.linked_label || 'a record' }}</template>
								<span v-if="f.decided_at" class="when">{{ formatDate(f.decided_at) }}</span>
							</li>
						</ul>
						<button type="button" class="st-btn" :disabled="al.undoing.value === g.batch!.id" data-test="autolink-undo" @click="al.undo(g.batch!.id)">Undo</button>
					</li>
				</ul>
				<p class="st-hint">Undoing puts the file back in your Inbox. <AppLink to="/inbox?tab=linked" class="rec">Open Recently linked →</AppLink></p>
			</div>
		</div>

		<v-dialog v-model="confirming" @esc="confirming = false">
			<v-card class="confirm">
				<v-card-title>{{ AUTO_LINK_TITLE }}?</v-card-title>
				<v-card-text>
					<p v-for="(p, i) in AUTO_LINK_CONSENT" :key="i">{{ p }}</p>
				</v-card-text>
				<v-card-actions>
					<div class="spacer" />
					<v-button secondary @click="confirming = false">Cancel</v-button>
					<v-button data-test="autolink-confirm" @click="turnOn">Turn on</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</Section>
</template>

<style scoped>
.consent { display: flex; flex-direction: column; gap: 4px; max-width: 70ch; }
.consent .now { font-weight: 600; color: var(--theme--foreground); }
.recent { display: flex; flex-direction: column; gap: 6px; }
.batches { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.batch { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); }
.files { margin: 0; padding: 0; list-style: none; font-size: var(--fs-sm, 12px); min-width: 0; }
.fname { font-weight: 650; overflow-wrap: anywhere; }
.when { margin-left: 8px; color: var(--d1-dim); }
.rec { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; }
.rec:hover { text-decoration: underline; }
.confirm { width: min(520px, calc(100vw - 24px)); }
.confirm p { margin: 0 0 8px; line-height: 1.5; }
.spacer { flex: 1; }
</style>
