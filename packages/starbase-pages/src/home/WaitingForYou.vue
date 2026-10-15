<script setup lang="ts">
// "Waiting for you" (spec 1.5): people who joined a team after you shared a record with it, and whose access to your records waits for you
// (pending members; Ruling D2: only where approving would raise their access). One line per joiner and team, "Femi Noor joined Additive ·
// 12 of your records", with Approve all, Decline all and Review (the records, with a choice for each). The card draws nothing at all when
// nothing is waiting, and also when the list cannot be read (a block of Home never draws an empty box or blanks the page).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RecordLink, Section, decidePending, listPending, useExplorerHost, useRequestGate } from '@d1/ui';
import type { PendingDecision, PendingItem, TeamRecord } from '@d1/ui';
import { kindLabel } from '../people/personPanel';
import { pendingLine } from '../teams/teamPage';

const host = useExplorerHost();
const gate = useRequestGate();
const items = ref<PendingItem[]>([]);
const reviewing = ref<string | null>(null);
const busy = ref<string | null>(null);
const failed = ref<Record<string, string>>({});

const keyOf = (p: Pick<PendingItem, 'team_id' | 'person_id'>) => `${p.team_id}:${p.person_id}`;
const recKey = (r: Pick<TeamRecord, 'collection' | 'id'>) => `${r.collection}:${r.id}`;

async function load() {
	const token = gate.begin();
	try {
		const rows = await listPending(host.api);
		if (gate.isCurrent(token)) items.value = rows;
	} catch {
		// the card is an extra: a failed read leaves it out rather than showing an error where a person has nothing to do
		if (gate.isCurrent(token)) items.value = [];
	}
}
onMounted(() => void load());
onBeforeUnmount(() => gate.cancel());

const visible = computed(() => items.value.length > 0);

async function decide(item: PendingItem, decision: PendingDecision, record?: TeamRecord) {
	const key = keyOf(item);
	busy.value = key;
	const { [key]: _gone, ...rest } = failed.value;
	failed.value = rest;
	try {
		await decidePending(host.api, {
			team_id: item.team_id,
			person_id: item.person_id,
			decision,
			...(record ? { records: [{ collection: record.collection, id: record.id }] } : {}),
		});
		await load();
	} catch (e: any) {
		failed.value = { ...failed.value, [key]: e?.message || 'Could not save that decision.' };
	} finally {
		busy.value = null;
	}
}
</script>

<template>
	<Section v-if="visible" title="Waiting for you" :count="items.length">
		<p class="intro">These people joined a team after you shared a record with it. They get access to your records only when you approve.</p>
		<ul class="items">
			<li v-for="p in items" :key="keyOf(p)" class="item">
				<div class="line">
					<span class="text">{{ pendingLine(p) }}</span>
					<span class="grow" />
					<v-button x-small :disabled="busy === keyOf(p)" @click="decide(p, 'approve')">Approve all</v-button>
					<v-button x-small secondary :disabled="busy === keyOf(p)" @click="decide(p, 'decline')">Decline all</v-button>
					<button type="button" class="link" :aria-expanded="reviewing === keyOf(p)" @click="reviewing = reviewing === keyOf(p) ? null : keyOf(p)">Review</button>
				</div>
				<p v-if="failed[keyOf(p)]" class="err" role="alert">{{ failed[keyOf(p)] }}</p>
				<ul v-if="reviewing === keyOf(p)" class="records" :aria-label="`Records ${p.full_name || 'they'} is waiting on`">
					<li v-for="r in p.records" :key="recKey(r)" class="rec">
						<span class="kind">{{ kindLabel(r.kind) }}</span>
						<RecordLink :collection="r.collection" :id="r.id">{{ r.code || 'No code' }}</RecordLink>
						<span class="rt">{{ r.title }}</span>
						<span class="grow" />
						<button type="button" class="link" :disabled="busy === keyOf(p)" @click="decide(p, 'approve', r)">Approve</button>
						<button type="button" class="link" :disabled="busy === keyOf(p)" @click="decide(p, 'decline', r)">Decline</button>
					</li>
				</ul>
			</li>
		</ul>
	</Section>
</template>

<style scoped>
.intro { margin: 0; padding: 8px 14px 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.items, .records { list-style: none; margin: 0; padding: 0; }
.item { padding: 8px 14px; border-top: 1px solid var(--d1-line); }
.item:first-child { border-top: 0; }
.line, .rec { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
.grow { flex: 1; }
.text { font-weight: 600; overflow-wrap: anywhere; }
.records { margin-top: 6px; padding-left: 4px; }
.rec { padding: 4px 0; }
.kind { font-size: var(--fs-xs, 11px); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--d1-dim); }
.rt { color: var(--d1-dim); overflow-wrap: anywhere; }
.err { margin: 4px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; cursor: pointer; }
.link:disabled { opacity: .5; cursor: default; }
</style>
