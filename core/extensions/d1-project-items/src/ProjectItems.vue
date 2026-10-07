<script setup lang="ts">
/*
 * Unified, read-only project items view (replaces the separate rollup table).
 * Reads project_rollup (materialised: every item belonging to a project, direct or
 * inherited via one of its campaigns) for the current project, groups by kind, and
 * renders only the non-empty sections. Items inherited through a campaign get a
 * coloured tag naming that campaign; directly-assigned items get none.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { RecordLink, ROLLUP_OPERATION_FIELDS, rollupOperationsFilter, rollupTargets, type RollupTarget } from '@d1/ui';

const props = defineProps<{ primaryKey?: string | number | null }>();
const api = useApi();

interface Row { row_id: string; kind: string; code: string; detail: string; campaign_id: string | null; }
const rows = ref<Row[]>([]);
const campaigns = ref<Record<string, { code: string; name: string }>>({});
const loading = ref(false);
// row_id -> record, so each row can link to its page. project_rollup rows hold no record id, but
// their row_id is a hash of it that rollupTargets() recomputes.
const targets = ref<Map<string, RollupTarget>>(new Map());
const target = (r: Row) => targets.value.get(r.row_id);

// Group order + labels/icons for the sections we know about; unknown kinds fall through.
const KINDS: { key: string; label: string; icon: string }[] = [
	{ key: 'operation', label: 'Operations', icon: 'build' },
	{ key: 'sample', label: 'Samples', icon: 'science' },
	{ key: 'test', label: 'Test sessions', icon: 'biotech' },
	{ key: 'equipment', label: 'Equipment', icon: 'precision_manufacturing' },
	{ key: 'tool', label: 'Tools', icon: 'handyman' },
	{ key: 'box', label: 'Insert boxes', icon: 'inventory_2' },
];
const KIND_FALLBACK = { label: 'Other', icon: 'category' };

const CAMPAIGN_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#b91c1c'];
const campaignColor = ref<Record<string, string>>({});

async function load() {
	const pk = props.primaryKey;
	if (!pk || pk === '+') { rows.value = []; targets.value = new Map(); return; }
	loading.value = true;
	targets.value = new Map();
	try {
		const res = await api.get('/items/project_rollup', {
			params: { filter: { project_id: { _eq: pk } }, fields: ['row_id', 'kind', 'code', 'detail', 'campaign_id'], limit: -1 },
		});
		rows.value = res.data?.data ?? [];
		// resolve campaign codes/names + assign a stable colour per campaign
		const ids = [...new Set(rows.value.map((r) => r.campaign_id).filter(Boolean))] as string[];
		if (ids.length) {
			const cr = await api.get('/items/campaigns', { params: { filter: { campaign_id: { _in: ids } }, fields: ['campaign_id', 'campaign_code', 'name'], limit: -1 } });
			const map: Record<string, { code: string; name: string }> = {};
			(cr.data?.data ?? []).forEach((c: any) => { map[c.campaign_id] = { code: c.campaign_code, name: c.name }; });
			campaigns.value = map;
			const col: Record<string, string> = {};
			ids.forEach((id, i) => { col[id] = CAMPAIGN_COLORS[i % CAMPAIGN_COLORS.length]; });
			campaignColor.value = col;
		}
	} catch { rows.value = []; } finally { loading.value = false; }
	await loadTargets(pk);
}

// Links are an extra: a failure here leaves the rows as plain text instead of hiding them. The
// operations are read in pages of ids (no code or name), so a big project is not one huge request.
const OPS_PAGE = 1000;
const OPS_MAX_PAGES = 20;
async function loadTargets(pk: string | number) {
	try {
		const ops: any[] = [];
		for (let page = 1; page <= OPS_MAX_PAGES; page++) {
			const res = await api.get('/items/manufacturing_operations', {
				params: { filter: rollupOperationsFilter(pk), fields: ROLLUP_OPERATION_FIELDS, sort: ['operation_id'], limit: OPS_PAGE, page },
			});
			const batch: any[] = res.data?.data ?? [];
			ops.push(...batch);
			if (batch.length < OPS_PAGE) break;
		}
		if (props.primaryKey === pk) targets.value = rollupTargets(ops, pk);
	} catch { /* rows stay unlinked */ }
}
onMounted(load);
watch(() => props.primaryKey, load);

// Build the ordered, non-empty sections.
const sections = computed(() => {
	const byKind: Record<string, Row[]> = {};
	for (const r of rows.value) (byKind[r.kind] ||= []).push(r);
	const out: { key: string; label: string; icon: string; items: Row[] }[] = [];
	for (const k of KINDS) if (byKind[k.key]?.length) { out.push({ ...k, items: byKind[k.key] }); delete byKind[k.key]; }
	for (const [k, items] of Object.entries(byKind)) if (items.length) out.push({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), icon: KIND_FALLBACK.icon, items });
	return out;
});
const total = computed(() => rows.value.length);
const inheritedCount = computed(() => rows.value.filter((r) => r.campaign_id).length);
function campaignLabel(id: string) { return campaigns.value[id]?.name || campaigns.value[id]?.code || 'campaign'; }
</script>

<template>
	<div class="pi">
		<div v-if="loading" class="pi-msg"><v-progress-circular indeterminate small /> Loading…</div>
		<div v-else-if="!total" class="pi-msg">No items assigned to this project yet.</div>
		<template v-else>
			<div class="pi-head">
				<span class="pi-count">{{ total }} item{{ total === 1 ? '' : 's' }}</span>
				<span v-if="inheritedCount" class="pi-sub">· {{ inheritedCount }} inherited via campaigns</span>
			</div>
			<div v-for="sec in sections" :key="sec.key" class="pi-sec">
				<div class="pi-sec-head"><v-icon :name="sec.icon" x-small /> {{ sec.label }} <span class="pi-n">{{ sec.items.length }}</span></div>
				<div class="pi-items">
					<div v-for="it in sec.items" :key="it.row_id" class="pi-item">
						<RecordLink v-if="target(it)" :collection="target(it)!.collection" :id="target(it)!.id" class="pi-code mono">{{ it.code || '—' }}</RecordLink>
						<span v-else class="pi-code mono">{{ it.code || '—' }}</span>
						<span v-if="it.detail" class="pi-detail">{{ it.detail }}</span>
						<span v-if="it.campaign_id" class="pi-tag" :style="{ background: campaignColor[it.campaign_id] }" :title="'Inherited from ' + campaignLabel(it.campaign_id)">{{ campaignLabel(it.campaign_id) }}</span>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.pi { font-size: 13px; }
.pi-msg { display: flex; align-items: center; gap: 8px; color: var(--theme--foreground-subdued, #6b7684); padding: 8px 2px; }
.pi-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 10px; }
.pi-count { font-weight: 700; }
.pi-sub { color: var(--theme--foreground-subdued, #6b7684); font-size: 12px; }
.pi-sec { margin-bottom: 14px; }
.pi-sec-head { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
	color: var(--theme--foreground-subdued, #6b7684); border-bottom: 1px solid var(--theme--border-color-subdued, #e7ebf0); padding-bottom: 4px; margin-bottom: 7px; }
.pi-n { margin-left: auto; background: var(--theme--background-subdued, #f1f5f9); border-radius: 99px; padding: 0 8px; font-size: 11px; }
.pi-items { display: flex; flex-direction: column; gap: 4px; }
.pi-item { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border: 1px solid var(--theme--border-color-subdued, #eef1f5); border-radius: 8px; background: var(--theme--background, #fff); }
.pi-code { font-weight: 650; }
.mono { font-family: var(--theme--fonts--monospace--font-family, 'SF Mono', Menlo, monospace); }
.pi-detail { color: var(--theme--foreground-subdued, #6b7684); font-size: 12px; }
.pi-tag { margin-left: auto; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 9px; border-radius: 99px; white-space: nowrap; }
</style>
