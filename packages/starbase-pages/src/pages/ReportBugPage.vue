<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AppLink, PageShell, Section, useExplorerHost } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import { getConsoleTail, getDiagnostics } from '../bugReport/capture';
import { issueLink, submitReport, type ReportKind } from '../bugReport/report';
import { AREAS, scopeOptions, scopeQuestion, suggestFromRoute } from '../bugReport/scopes';
import '../labels/form.css';

// Report a bug: files a GitHub issue through d1-server's d1-bug-report endpoint (which knows who you are
// from your session and holds the credentials; the browser never does). Replaces the old Data Studio
// module. No list of existing reports: that needs the relay's issue list.
const host = useExplorerHost();

const kind = ref<ReportKind>('bug');
const area = ref('general');
const scope = ref('');
const includeDiagnostics = ref(false);
const title = ref('');
const description = ref('');

// vue-router records where the person navigated from; by the time they are here the page they were
// on is no longer in the address, so this is the best available "where did it happen".
// The query and fragment are dropped: they can carry record ids or tokens, and the server also strips them.
const route = ((window.history.state?.back as string | undefined) || 'unknown').replace(/[?#].*/s, '') || 'unknown';
const suggestion = suggestFromRoute(route);
if (suggestion) {
	area.value = suggestion.area;
	scope.value = suggestion.scope;
}

const options = computed(() => scopeOptions(area.value));
watch(area, () => {
	if (!options.value.some((o) => o.value === scope.value)) scope.value = '';
});

// Read when the box is opened and again at send time, so it shows what would go, and what goes is current.
const preview = ref('');
function refreshPreview() {
	preview.value = [getDiagnostics(), '', '-- Console (warnings and errors) --', getConsoleTail() || '(none)'].join('\n');
}
refreshPreview();

const sending = ref(false);
const failure = ref('');
const created = ref<{ url: string; number: number | null } | null>(null);
const canSend = computed(() => !!title.value.trim() && !sending.value);

async function send() {
	if (!canSend.value) return;
	sending.value = true;
	failure.value = '';
	created.value = null;
	const result = await submitReport(host.api, {
		kind: kind.value,
		area: area.value,
		scope: scope.value,
		title: title.value,
		description: description.value,
		route,
		...(includeDiagnostics.value ? { diagnostics: getDiagnostics(), consoleTail: getConsoleTail() } : {}),
	});
	sending.value = false;
	if (result.ok) {
		created.value = { url: result.url, number: result.number };
		title.value = '';
		description.value = '';
	} else {
		failure.value = result.reason;
	}
}
</script>

<template>
	<ExplorerView title="Report a bug">
		<template #headline><AppLink to="/home">Home</AppLink></template>
		<PageShell narrow>
			<Section title="Report a bug or ask for a feature">
				<form class="rb-form" @submit.prevent="send">
					<p class="rb-hint">
						Found something broken, or want something added? Tell us here. It goes straight to the project's issue tracker with who you are and
						where you were. No GitHub account needed.
					</p>

					<fieldset class="rb-kinds">
						<legend class="rb-sr">Type of report</legend>
						<label class="lf-check" :class="{ on: kind === 'bug' }"><input v-model="kind" type="radio" value="bug" data-test="bug-kind-bug" /> Bug</label>
						<label class="lf-check" :class="{ on: kind === 'feature' }"><input v-model="kind" type="radio" value="feature" data-test="bug-kind-feature" /> Feature request</label>
					</fieldset>

					<div class="lf-row">
						<label class="lf-field grow">Where in STARbase?
							<select v-model="area" data-test="bug-area">
								<option v-for="a in AREAS" :key="a.value" :value="a.value">{{ a.label }}</option>
							</select>
						</label>
						<label v-if="options.length" class="lf-field grow">{{ scopeQuestion(area) }} (optional)
							<select v-model="scope" data-test="bug-scope">
								<option value="">Not sure / not specific</option>
								<option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
							</select>
						</label>
					</div>

					<label class="lf-field">Title
						<input v-model="title" type="text" maxlength="200" autocomplete="off" placeholder="One line: what went wrong?" data-test="bug-title" />
					</label>

					<label class="lf-field">Details
						<textarea v-model="description" rows="7" placeholder="What did you do, what did you expect, and what happened instead?" data-test="bug-description" />
					</label>

					<label class="lf-check">
						<input v-model="includeDiagnostics" type="checkbox" data-test="bug-debug" @change="refreshPreview" />
						<span>Include diagnostics. This adds browser details and recent console errors, which may contain record values. Passwords and tokens are stripped.</span>
					</label>
					<details v-if="includeDiagnostics" class="rb-preview" @toggle="refreshPreview">
						<summary>See exactly what will be attached</summary>
						<pre data-test="bug-debug-preview">{{ preview }}</pre>
					</details>

					<p class="rb-hint">Page you came from: <code>{{ route }}</code></p>

					<p v-if="failure" class="d1-note bad" role="alert" data-test="bug-error">{{ failure }}</p>
					<p v-if="created" class="d1-note" role="status" data-test="bug-success">
						Thanks, your report was filed<template v-if="created.number !== null">
							as <a v-if="issueLink(created.url)" :href="issueLink(created.url)!" target="_blank" rel="noopener noreferrer">#{{ created.number }}</a><template v-else>#{{ created.number }}</template></template>.
					</p>

					<div class="lf-row">
						<button type="submit" class="lf-btn pri" :disabled="!canSend" data-test="bug-submit">{{ sending ? 'Sending…' : 'Send report' }}</button>
					</div>
				</form>
			</Section>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.rb-form { display: flex; flex-direction: column; gap: 14px; }
.rb-form .lf-row > .grow { flex: 1; min-width: 180px; }
.rb-hint { margin: 0; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.rb-kinds { display: flex; gap: 8px; border: 0; margin: 0; padding: 0; min-width: 0; }
.rb-kinds .lf-check {
	padding: 6px 14px; border: 1px solid var(--d1-line, var(--theme--border-color)); border-radius: 8px; background: var(--d1-tile, transparent);
}
.rb-kinds .lf-check.on { border-color: var(--d1-accent, var(--theme--primary)); }
.rb-preview summary { cursor: pointer; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.rb-preview pre {
	max-height: 220px; overflow: auto; margin: 8px 0 0; padding: 10px 12px; font-size: var(--fs-sm, 12px);
	white-space: pre-wrap; word-break: break-all; border: 1px solid var(--d1-line, var(--theme--border-color)); border-radius: 6px;
	background: var(--d1-tile, var(--theme--background-subdued));
}
.rb-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
