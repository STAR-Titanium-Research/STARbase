<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { AppLink, Section, ago, crawlerOnline, formatDate, overviewTime, ownerlessRows, ownerlessTotal } from '@d1/ui';
import { useAdminOverview } from './useAdminOverview';

// Three admin-only panels under the work panels: the force crawler's queue, files the indexer
// flagged missing on the share, and records with no owner. All three come from one call
// (useAdminOverview). The whole call failing is one quiet line, not three broken panels; a part that
// failed on the server is null and only that panel's body says it could not load. No panel is ever
// an empty box: each one says what it found, including "nothing" with a tick.
// `isAdmin` here is the server-confirmed flag (home.vue), so a member never reaches the endpoint.
const props = defineProps<{ isAdmin: boolean }>();
const { data, error, loading, fetchedAt } = useAdminOverview(computed(() => props.isAdmin));

// The crawler's verdict is made once per answer, against the database's own clock (the one the
// heartbeat is stamped with): it neither follows the browser's clock nor drifts to "Offline" between
// refreshes. Only the "x ago" texts move on with the time since the answer, on a slow tick that runs
// for admins only and not while the tab is hidden.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
watch(
	() => props.isAdmin,
	(on) => {
		if (tick) clearInterval(tick);
		tick = on ? setInterval(() => { if (!document.hidden) now.value = Date.now(); }, 5000) : null;
	},
	{ immediate: true },
);
onBeforeUnmount(() => { if (tick) clearInterval(tick); });

const serverTime = computed(() => data.value?.serverTime ?? null);
const reference = computed(() => overviewTime(serverTime.value, fetchedAt.value, now.value));
const crawler = computed(() => data.value?.crawler ?? null);
const online = computed(() => crawlerOnline(crawler.value?.state?.last_heartbeat_at, overviewTime(serverTime.value, fetchedAt.value)));
const heartbeat = computed(() => ago(crawler.value?.state?.last_heartbeat_at, reference.value));
const ownerless = computed(() => (data.value?.ownerless ? ownerlessRows(data.value.ownerless) : []));
const ownerlessAll = computed(() => (data.value?.ownerless ? ownerlessTotal(data.value.ownerless) : 0));
const nf = (n: number) => n.toLocaleString('en-GB');
</script>

<template>
	<template v-if="isAdmin">
		<p v-if="loading && !data" class="d1-note quiet">Loading the admin overview…</p>
		<p v-else-if="error && !data" class="d1-note quiet" role="status">The admin overview is not available right now ({{ error }}).</p>
		<div v-else-if="data" class="panels">
			<Section title="Force crawler">
				<template #actions><AppLink to="/d1-force-crawler" class="link">Open crawler →</AppLink></template>
				<p v-if="!crawler" class="d1-note">Could not load the crawler status.</p>
				<template v-else>
					<p v-if="!crawler.state" class="status"><span class="dot off" /> No crawler has reported in yet</p>
					<template v-else>
						<p class="status">
							<span class="dot" :class="online ? 'on' : 'off'" />
							<strong>{{ online ? 'Online' : 'Offline' }}</strong>
							<span v-if="crawler.state.desired_state" class="dim">set to {{ crawler.state.desired_state }}</span>
						</p>
						<p v-if="online && crawler.state.current_activity" class="activity">{{ crawler.state.current_activity }}</p>
						<p v-if="heartbeat" class="d1-note">Last heartbeat {{ heartbeat }}</p>
						<dl class="facts">
							<div><dt>Processed</dt><dd>{{ nf(crawler.state.processed_count) }}</dd></div>
							<div><dt>Errors</dt><dd :class="{ bad: crawler.state.error_count > 0 }">{{ nf(crawler.state.error_count) }}</dd></div>
						</dl>
					</template>
					<dl class="facts queue" aria-label="Force analysis queue">
						<div><dt>Pending</dt><dd>{{ nf(crawler.analyses.pending) }}</dd></div>
						<div><dt>Processing</dt><dd>{{ nf(crawler.analyses.processing) }}</dd></div>
						<div><dt>Error</dt><dd :class="{ bad: crawler.analyses.error > 0 }">{{ nf(crawler.analyses.error) }}</dd></div>
					</dl>
				</template>
			</Section>

			<Section title="Files missing on the share" :count="data.missingFiles ? data.missingFiles.count : null">
				<template #actions><AppLink to="/files" class="link">Files →</AppLink></template>
				<p v-if="!data.missingFiles" class="d1-note">Could not load the missing-file list.</p>
				<template v-else>
					<p v-if="data.missingFiles.count === 0" class="status"><span class="dot on" /> No file is flagged missing ✓</p>
					<template v-else>
						<p class="d1-note">Latest {{ data.missingFiles.recent.length }} of {{ nf(data.missingFiles.count) }}, newest first</p>
						<ul class="files">
							<li v-for="f in data.missingFiles.recent" :key="f.id">
								<AppLink :to="`/files/${f.id}`" class="name">{{ f.filename_download || f.id }}</AppLink>
								<span class="dim" :title="f.missing_since ? formatDate(f.missing_since) : ''">{{ f.missing_since ? ago(f.missing_since, reference) : 'unknown' }}</span>
							</li>
						</ul>
					</template>
					<p v-if="!data.fingerprints" class="d1-note">Fingerprint counts could not be loaded.</p>
					<dl v-else class="facts queue" aria-label="File fingerprints">
						<div><dt>Fingerprinted</dt><dd>{{ nf(data.fingerprints.done) }}</dd></div>
						<div><dt>Missing</dt><dd :class="{ warn: data.fingerprints.missing > 0 }">{{ nf(data.fingerprints.missing) }}</dd></div>
						<div><dt>Error</dt><dd :class="{ bad: data.fingerprints.error > 0 }">{{ nf(data.fingerprints.error) }}</dd></div>
					</dl>
				</template>
			</Section>

			<Section title="Ownerless records" :count="data.ownerless ? ownerlessAll : null">
				<p v-if="!data.ownerless" class="d1-note">Could not load the ownerless counts.</p>
				<p v-else-if="ownerlessAll === 0" class="status"><span class="dot on" /> Every record has an owner ✓</p>
				<ul v-else class="owners">
					<li v-for="r in ownerless" :key="r.key">
						<AppLink :to="r.to" class="owner-row" :class="{ zero: r.count === 0 }">
							<span class="o-count">{{ nf(r.count) }}</span>
							<span class="o-label">{{ r.label }}</span>
							<span class="o-go">→</span>
						</AppLink>
					</li>
				</ul>
			</Section>
		</div>
	</template>
</template>

<style scoped>
/* Equal-height panels: the grid stretches its items (the sections), unlike .d1-cols. */
.panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: stretch; }
.quiet { padding: 2px 4px; }
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.dim { color: var(--d1-dim); font-size: var(--fs-sm); }
.status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 6px; }
.activity { margin: 0 0 4px; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--d1-dim); }
.dot.on { background: var(--d1-ok); }
.dot.off { background: var(--d1-dim); }
.facts { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; padding: 0; }
.facts > div {
	/* Label above value. Directus's own stylesheet makes `dl > div` a row and `dd` a shrinking, ellipsised
	   flex item, which cut "183" to "1…" in a narrow tile: the tile is a column here and the value never
	   shrinks or truncates; a long label wraps instead. */
	display: flex; flex-direction: column; flex: 1 1 80px; min-width: min-content; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
}
.facts dt { display: block; font-size: var(--fs-xs); font-weight: 600; color: var(--d1-dim); overflow-wrap: anywhere; }
.facts dd {
	display: block; flex: none; margin: 0; overflow: visible; text-overflow: clip; white-space: nowrap;
	color: var(--theme--foreground); font-size: var(--fs-lg, 15px); font-weight: 700; font-variant-numeric: tabular-nums;
}
.facts dd.bad { color: var(--d1-bad); }
.facts dd.warn { color: var(--d1-warn); }
.files { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.files li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.files .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--d1-accent, var(--theme--primary)); text-decoration: none; font-size: var(--fs-sm); }
.files .name:hover { text-decoration: underline; }
.files .dim { white-space: nowrap; flex: none; }
.owners { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.owner-row {
	display: flex; align-items: center; gap: 12px; padding: 7px 12px; text-decoration: none; color: var(--theme--foreground);
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); transition: border-color 0.12s ease;
}
.owner-row:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.owner-row:not(.zero) .o-count { color: var(--d1-warn); }
.o-count { min-width: 2.2em; font-size: var(--fs-xl, 18px); font-weight: 700; font-variant-numeric: tabular-nums; }
.o-label { flex: 1; font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); }
.o-go { color: var(--d1-dim); }
</style>
