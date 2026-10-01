<script setup lang="ts">
// Files a GitHub issue directly from inside the app. The backend holds the GitHub token (see
// backend/app/bug_report.py) — this form only ever talks to our own recorder backend, never to
// GitHub directly, so no credential of any kind lives in the renderer.
import { onMounted, ref } from 'vue';
import { lastNonSettingsRoute } from '../router';
import { getConfig } from '../config';
import { authStore } from '../authStore';
import { getConsoleTail } from '../clientLog';
// #42: draft form fields live in this sibling module (not local refs) so switching Settings tabs
// or popping the window — either of which unmounts this component — no longer wipes whatever the
// operator had already typed. See reportBugDraft.ts for why.
import { draftArea, draftDescription, draftIncludeLogs, draftKind, draftTitle, resetDraft } from './reportBugDraft';

const base = () => getConfig().recorderUrl;

// Mirrors backend/app/bug_report.py's AREAS — keep both lists in sync. A fixed set (not free
// text) so the resulting `area:*` GitHub label is always one of these, which is the whole point:
// a stable, filterable catalogue instead of re-reading every report's body to find its section.
const AREAS: { value: string; label: string }[] = [
	{ value: 'recording', label: 'Recording' },
	{ value: 'plotting', label: 'Plotting' },
	{ value: 'diagnostics', label: 'Diagnostics' },
	{ value: 'settings', label: 'Settings' },
	{ value: 'labamp', label: 'Lab Amp' },
	{ value: 'nidaq', label: 'NI-DAQ' },
	{ value: 'gui', label: 'GUI / layout (not page-specific)' },
	{ value: 'general', label: 'General / other' },
];
// Pre-select based on where the report is actually being filed from — the reporter can still
// override it (e.g. a plotting bug noticed while back on Settings). Detached popout windows
// (/live, /diag-panel) map to the section they're a window onto, not to "general".
function areaForRoute(path: string): string {
	if (path.startsWith('/record') || path.startsWith('/live')) return 'recording';
	if (path.startsWith('/plot')) return 'plotting';
	if (path.startsWith('/diagnostics') || path.startsWith('/diag-panel')) return 'diagnostics';
	if (path.startsWith('/settings')) return 'settings';
	if (path.startsWith('/labamp')) return 'labamp';
	if (path.startsWith('/nidaq')) return 'nidaq';
	return 'general';
}

const kind = draftKind;
const area = draftArea;
const title = draftTitle;
const description = draftDescription;
const includeLogs = draftIncludeLogs;

const configured = ref<boolean | null>(null); // null = still checking
const submitting = ref(false);
const result = ref<{ ok: boolean; url?: string; reason?: string } | null>(null);
const appVersion = ref('');

interface IssueRow {
	number: number;
	title: string;
	url: string;
	state: string;
	labels: string[];
	created_at?: string;
}
const issues = ref<IssueRow[]>([]);
const issuesLoading = ref(false);
const issuesErr = ref('');
async function fetchIssues() {
	issuesLoading.value = true;
	issuesErr.value = '';
	try {
		const res = await fetch(`${base()}/support/report-bug/issues`);
		const data = await res.json();
		if (data.ok) issues.value = data.issues || [];
		else issuesErr.value = data.reason || 'could not load recent reports';
	} catch (e: any) {
		issuesErr.value = e?.message || "couldn't reach the recording backend";
	} finally {
		issuesLoading.value = false;
	}
}

onMounted(() => {
	// Only re-guess the area for a genuinely fresh form — once a draft has content, remounting
	// (switching tabs and back) must not clobber an area the operator may have deliberately
	// changed away from the route-based guess.
	if (!title.value && !description.value) area.value = areaForRoute(lastNonSettingsRoute.value);
	// Independent requests — run them concurrently rather than one-after-the-other.
	const statusP = fetch(`${base()}/support/report-bug`)
		.then((res) => res.json())
		.then((data) => {
			configured.value = !!data.configured;
			if (configured.value) fetchIssues();
		})
		.catch(() => { configured.value = false; });
	const versionP = window.forceApp
		? window.forceApp.getUpdateInfo()
			.then((info) => { appVersion.value = info.version; })
			.catch(() => { /* browser-served build or bridge unavailable — version stays blank */ })
		: Promise.resolve();
	return Promise.all([statusP, versionP]);
});

async function submit() {
	if (!title.value.trim() || submitting.value) return;
	submitting.value = true;
	result.value = null;
	try {
		const body = new URLSearchParams({
			title: title.value.trim(),
			description: description.value.trim(),
			app_version: appVersion.value,
			platform: navigator.platform || '',
			route: lastNonSettingsRoute.value,
			reporter_email: authStore.currentUser.value?.email || '',
			include_logs: String(includeLogs.value),
			kind: kind.value,
			area: area.value,
			// Gated on the same checkbox as the backend log: both are diagnostic attachments, and
			// an operator who declines to attach logs has not agreed to send their console either.
			console_tail: includeLogs.value ? getConsoleTail() : '',
		});
		const res = await fetch(`${base()}/support/report-bug`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		});
		const data = await res.json();
		result.value = data;
		if (data.ok) {
			resetDraft();
			fetchIssues();
		}
	} catch (e: any) {
		result.value = { ok: false, reason: e?.message || "couldn't reach the recording backend" };
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<div class="report">
		<h2>Report a bug or request a feature</h2>
		<p class="lead">
			Opens an issue directly on the project's GitHub, with your description plus the app version,
			current page, and (optionally) a tail of the recent backend log — the same log Settings > Logs
			shows.
		</p>

		<div v-if="configured === false" class="warnbox">
			<span class="material-symbols-rounded">warning</span>
			<div>
				<b>Not configured on this machine</b>
				<span>This install has no GitHub token set for filing reports. Describe the bug to whoever
					manages this app's deployment, or attach a Settings &gt; Logs export manually.</span>
			</div>
		</div>

		<template v-else>
			<div class="kindpick segmode lg" role="radiogroup" aria-label="Report type">
				<button type="button" class="segbtn" :class="{ on: kind === 'bug' }" role="radio" :aria-checked="kind === 'bug'"
					:disabled="submitting" @click="kind = 'bug'">
					<span class="material-symbols-rounded">bug_report</span> Bug
				</button>
				<button type="button" class="segbtn" :class="{ on: kind === 'feature' }" role="radio" :aria-checked="kind === 'feature'"
					:disabled="submitting" @click="kind = 'feature'">
					<span class="material-symbols-rounded">lightbulb</span> Feature request
				</button>
			</div>
			<label class="field area-field">
				<span>Area</span>
				<select v-model="area" :disabled="submitting">
					<option v-for="a in AREAS" :key="a.value" :value="a.value">{{ a.label }}</option>
				</select>
			</label>
			<label class="field">
				<span>Title</span>
				<input v-model="title" :placeholder="kind === 'bug' ? 'short summary of what went wrong' : 'short summary of what you\'d like to see'" maxlength="250" :disabled="submitting" />
			</label>
			<label class="field">
				<span>{{ kind === 'bug' ? 'What happened?' : 'What would you like?' }}</span>
				<textarea v-model="description" rows="6"
					:placeholder="kind === 'bug' ? 'what you did, what you expected, what happened instead…' : 'what you want, and why it would help…'"
					:disabled="submitting"></textarea>
			</label>
			<label class="chk">
				<input type="checkbox" v-model="includeLogs" :disabled="submitting" />
				Include diagnostics: recent backend log, this window's console, and machine state
				(amp mode, NI-DAQ devices, channel map, disk space). Helps a lot — no personal data
				beyond your login email, which is included separately below.
			</label>

			<button class="btn primary" :disabled="!title.trim() || submitting || configured === null" @click="submit">
				<span class="material-symbols-rounded">{{ submitting ? 'hourglass_top' : (kind === 'bug' ? 'bug_report' : 'lightbulb') }}</span>
				{{ submitting ? 'Filing…' : (kind === 'bug' ? 'File bug report' : 'File feature request') }}
			</button>

			<p v-if="result?.ok" class="ok">
				<span class="material-symbols-rounded">check_circle</span>
				Filed as <a :href="result.url" target="_blank" rel="noopener">issue #{{ (result as any).number ?? '' }}</a>.
			</p>
			<p v-else-if="result && !result.ok" class="err">
				<span class="material-symbols-rounded">error</span>{{ result.reason }}
			</p>

			<div class="issues">
				<div class="issues-head">
					<h3>Recently reported</h3>
					<button class="btn icon sm quiet" type="button" title="Refresh" aria-label="Refresh" :disabled="issuesLoading" @click="fetchIssues">
						<span class="material-symbols-rounded" :class="{ spin: issuesLoading }">refresh</span>
					</button>
				</div>
				<p v-if="issuesErr" class="err"><span class="material-symbols-rounded">error</span>{{ issuesErr }}</p>
				<p v-else-if="!issuesLoading && !issues.length" class="empty">Nothing reported from the app yet.</p>
				<ul v-else class="issue-list">
					<li v-for="i in issues" :key="i.number">
						<a :href="i.url" target="_blank" rel="noopener">#{{ i.number }} {{ i.title }}</a>
						<span class="badge" :class="i.state">{{ i.state }}</span>
					</li>
				</ul>
			</div>
		</template>
	</div>
</template>

<style scoped>
.report { max-width: 640px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.warnbox { display: flex; gap: 10px; padding: 11px 13px; margin-bottom: 14px; font-size: var(--fs-md);
	background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 9px; }
.warnbox .material-symbols-rounded { font-size: var(--icon-lg); color: var(--warn); }
.warnbox div { display: flex; flex-direction: column; gap: 2px; }
.warnbox b { font-size: var(--fs-md); }
.warnbox span { color: var(--text-dim); line-height: 1.45; }

.kindpick { margin-bottom: 16px; }

.field { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-md); color: var(--text-dim); margin-bottom: 14px; }
.field input, .field textarea, .field select { padding: 9px 11px; font: inherit; font-size: var(--fs-md); color: var(--text);
	background: var(--surface); border: 1px solid var(--border); border-radius: 8px; outline: none; resize: vertical; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); }
.area-field select { max-width: 280px; }

.chk { display: flex; align-items: flex-start; gap: 8px; font-size: var(--fs-md); color: var(--text); cursor: pointer; margin-bottom: 16px; line-height: 1.4; }
.chk input { accent-color: var(--accent); margin-top: 2px; }


.ok { display: flex; align-items: center; gap: 5px; color: var(--ok); font-size: var(--fs-md); margin-top: 10px; }
.ok a { color: inherit; text-decoration: underline; }
.err { display: flex; align-items: center; gap: 5px; color: var(--danger); font-size: var(--fs-md); margin-top: 10px; }

.issues { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border); }
.issues-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.issues-head h3 { margin: 0; font-size: var(--fs-md); font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.empty { font-size: var(--fs-md); color: var(--text-dim); }
.issue-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
.issue-list li { display: flex; align-items: center; gap: 8px; padding: 7px 9px; font-size: var(--fs-md); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; }
.issue-list a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; }
.issue-list a:hover { text-decoration: underline; }
.badge { flex: 0 0 auto; padding: 2px 8px; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; border-radius: 99px; }
.badge.open { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.badge.closed { color: var(--text-dim); background: rgba(255,255,255,0.06); }
</style>
