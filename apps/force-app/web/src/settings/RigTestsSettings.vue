<script setup lang="ts">
// Settings > Rig tests: whether this PC takes rig-test requests (and why not), the relay state, the
// rig id, the requests waiting for an answer and the last runs. Reads the same store as the
// consent prompt, so a request answered here disappears from the dialog and the badge too.
import { computed, onMounted } from 'vue';
import RigTestRequestCard from '../rigtest/RigTestRequestCard.vue';
import { rigTest } from '../rigtest/rigTestStore';
import { summaryCounts } from '../rigtest/rigTestLogic';

const s = rigTest.state;
const elig = computed(() => s.eligibility);
const RELAY: Record<string, { text: string; tone: string }> = {
	ok: { text: 'Request relay reachable', tone: 'ok' },
	unreachable: { text: 'Request relay unreachable: new requests cannot arrive', tone: 'bad' },
	not_configured: { text: 'Request relay not configured on this PC', tone: 'dim' },
};
const relay = computed(() => RELAY[elig.value?.relay ?? 'not_configured']);

function refresh() { void rigTest.refreshEligibility(); void rigTest.refreshPending(); void rigTest.refreshHistory(); }
onMounted(refresh);

const STATE_LABEL: Record<string, string> = {
	done: 'Passed', partial: 'Partial', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted', running: 'Running',
};
const stateLabel = (x: string) => STATE_LABEL[x] ?? x;
function when(iso?: string): string {
	const d = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(d) ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
</script>

<template>
	<div class="rts">
		<div class="rts-head">
			<h2>Rig tests</h2>
			<button type="button" class="btn icon sm quiet" title="Refresh" aria-label="Refresh" @click="refresh">
				<span class="material-symbols-rounded">refresh</span>
			</button>
		</div>
		<p class="lead">
			Your admin can ask this PC to run checks from the lab's physical-test list. You are asked first, can
			snooze or decline, and can cancel a run at any time. Nothing runs while you are recording.
		</p>

		<p v-if="!s.available" class="note dim">
			<span class="material-symbols-rounded">info</span>This recorder is too old for rig tests. Update the app.
		</p>

		<section v-else class="card" aria-label="Eligibility">
			<div class="row">
				<span class="material-symbols-rounded" :class="elig?.eligible ? 'ok' : 'dim'">{{ elig?.eligible ? 'check_circle' : 'do_not_disturb_on' }}</span>
				<div>
					<b>{{ elig ? (elig.eligible ? 'This PC takes rig-test requests' : 'This PC does not take rig-test requests') : 'Checking…' }}</b>
					<span v-if="elig && !elig.eligible && elig.reason" class="sub">{{ elig.reason }}</span>
				</div>
			</div>
			<div class="row">
				<span class="material-symbols-rounded" :class="relay.tone">{{ elig?.relay === 'ok' ? 'cloud_done' : 'cloud_off' }}</span>
				<div><span>{{ relay.text }}</span></div>
			</div>
			<div v-if="elig?.rig_id" class="row">
				<span class="material-symbols-rounded dim">badge</span>
				<div><span>Rig ID: <code>{{ elig.rig_id }}</code></span></div>
			</div>
		</section>

		<template v-if="s.available">
			<h3>Waiting for you</h3>
			<p v-if="!s.pending.length" class="empty">No requests are waiting.</p>
			<div v-else class="list">
				<article v-for="r in s.pending" :key="r.number" class="card"><RigTestRequestCard :request="r" /></article>
			</div>
			<p v-if="rigTest.runActive.value" class="note">
				<span class="material-symbols-rounded">science</span>A rig test is running.
				<button type="button" class="btn sm" @click="rigTest.restore()">Show it</button>
			</p>

			<h3>Recent runs</h3>
			<p v-if="!s.history.length" class="empty">No rig tests have run on this PC yet.</p>
			<table v-else class="hist">
				<thead><tr><th>Request</th><th>Result</th><th>Passed</th><th>Failed</th><th>When</th></tr></thead>
				<tbody>
					<tr v-for="h in s.history" :key="`${h.number}-${h.started_at}`">
						<td class="req">
							<a v-if="h.url" :href="h.url" target="_blank" rel="noopener">#{{ h.number }}<template v-if="h.title"> {{ h.title }}</template></a>
							<span v-else>#{{ h.number }}<template v-if="h.title"> {{ h.title }}</template></span>
						</td>
						<td><span class="pill" :class="h.state">{{ stateLabel(h.state) }}</span></td>
						<td class="n">{{ summaryCounts(h).pass }}</td>
						<td class="n">{{ summaryCounts(h).fail }}</td>
						<td class="when">{{ when(h.finished_at || h.started_at) }}</td>
					</tr>
				</tbody>
			</table>
		</template>
	</div>
</template>

<style scoped>
.rts { max-width: 680px; }
.rts-head { display: flex; align-items: center; justify-content: space-between; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
h3 { margin: 24px 0 8px; font-size: var(--fs-md); font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.lead { margin: 0 0 16px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.card { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; }
.list { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; align-items: flex-start; gap: 10px; font-size: var(--fs-md); }
.row > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.row .material-symbols-rounded { font-size: var(--icon-lg); }
.sub { color: var(--text-dim); line-height: 1.4; overflow-wrap: anywhere; }
.ok { color: var(--ok); } .bad { color: var(--danger); } .dim { color: var(--text-dim); }
code { font-size: var(--fs-sm); }
.empty { margin: 0; font-size: var(--fs-md); color: var(--text-dim); }
.note { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; font-size: var(--fs-md); }
.note.dim { color: var(--text-dim); }
.hist { width: 100%; border-collapse: collapse; font-size: var(--fs-md); }
.hist th { text-align: left; padding: 6px 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.hist td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.hist .n { font-variant-numeric: tabular-nums; text-align: right; }
.hist th:nth-child(3), .hist th:nth-child(4) { text-align: right; }
.hist .req { overflow-wrap: anywhere; }
.hist .req a { color: var(--text); text-decoration: none; }
.hist .req a:hover { text-decoration: underline; }
.hist .when { color: var(--text-dim); white-space: nowrap; }
.pill { padding: 2px 8px; font-size: var(--fs-xs); font-weight: 700; border-radius: 99px; background: var(--surface-2); color: var(--text-dim); white-space: nowrap; }
.pill.done { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.pill.partial, .pill.timed_out, .pill.interrupted { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
</style>
