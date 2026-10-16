<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { IgnoredRule, FoundFile } from './inboxApi';
import { IGNORE_HINT, VIEWER_TEXT, knownFolders } from './ignoredFolders';
import { ownerText } from './inboxModel';
import type { Outcome } from './useInbox';

// "Ignored folders" on the Inbox page: a quiet disclosure (one line while closed) listing the rules with Remove, and a field to add one, fed by the folders
// of the files on screen and free typing (checked the way the server checks it, see ignoredFolders.ts). A Lab Viewer sees the rules, with Remove off and
// the reason. The page does the work (useIgnoredFolders); this only reports what was asked.
const props = defineProps<{
	rules: IgnoredRule[];
	open: boolean;
	loading: boolean;
	/** Why the list could not be read or a rule could not be removed. */
	error: string;
	readOnly: boolean;
	/** The id of the rule being removed. */
	removing: string | null;
	adding: boolean;
	/** The files on screen: the folders they sit in are the choices. */
	rows: FoundFile[];
	/** The teams whose folder a rule can be for. */
	teams: Array<{ team_id: string; name: string }>;
	/** The person has a folder of their own. */
	hasOwn: boolean;
	/** Adds the rule: the page answers ok, or the words to show next to the field. */
	add: (folder: string, teamId: string | null) => Promise<Outcome>;
}>();
const emit = defineEmits<{ (e: 'toggle', open: boolean): void; (e: 'remove', rule: IgnoredRule): void }>();

const owners = computed(() => [
	...(props.hasOwn || props.teams.length === 0 ? [{ key: 'me', teamId: null as string | null, text: 'My folder' }] : []),
	...props.teams.map((t) => ({ key: `team:${t.team_id}`, teamId: t.team_id as string | null, text: `${t.name} team folder` })),
]);
const ownerKeyChosen = ref('me');
watch(owners, (o) => { if (!o.some((x) => x.key === ownerKeyChosen.value)) ownerKeyChosen.value = o[0]?.key ?? 'me'; }, { immediate: true });
const chosen = computed(() => owners.value.find((o) => o.key === ownerKeyChosen.value) ?? owners.value[0]);
const choices = computed(() => knownFolders(props.rows, chosen.value?.key ?? 'me', props.rules));

const typed = ref('');
const problem = ref('');
async function submit() {
	if (props.adding) return;
	problem.value = '';
	const r = await props.add(typed.value, chosen.value?.teamId ?? null);
	if (r.ok) typed.value = '';
	else problem.value = r.message;
}
const someLocked = computed(() => props.rules.some((r) => !r.can_remove));
const showOwner = computed(() => props.teams.length > 0);
</script>

<template>
	<section class="ignored" data-test="ignored">
		<button type="button" class="lf-link toggle" :aria-expanded="open" aria-controls="ignored-body" data-test="ignored-toggle" @click="emit('toggle', !open)">
			{{ open ? 'Hide' : 'Show' }} ignored folders<template v-if="rules.length"> ({{ rules.length }})</template>
		</button>
		<div v-if="open" id="ignored-body" class="body">
			<p class="d1-note">{{ IGNORE_HINT }}</p>
			<p v-if="error" class="err" role="alert" data-test="ignored-error">{{ error }}</p>
			<p v-if="!rules.length && !loading" class="d1-note" data-test="ignored-empty">No folders are ignored.</p>
			<ul v-if="rules.length" class="list" data-test="ignored-list">
				<li v-for="r in rules" :key="r.ignored_id" data-test="ignored-rule">
					<span class="folder" data-test="ignored-folder">{{ r.folder }}</span>
					<span v-if="showOwner" class="owner" data-test="ignored-owner">{{ ownerText(r) }}</span>
					<v-button x-small secondary :disabled="!r.can_remove || removing !== null" :loading="removing === r.ignored_id" :title="r.can_remove ? undefined : VIEWER_TEXT" data-test="ignored-remove" @click="emit('remove', r)">Remove</v-button>
				</li>
			</ul>
			<p v-if="someLocked" class="d1-note" data-test="ignored-readonly">{{ VIEWER_TEXT }}</p>
			<div v-if="!readOnly" class="add lf-row">
				<label v-if="owners.length > 1" class="lf-field">In
					<select v-model="ownerKeyChosen" data-test="ignored-owner-select">
						<option v-for="o in owners" :key="o.key" :value="o.key">{{ o.text }}</option>
					</select>
				</label>
				<label class="lf-field grow">Folder to ignore
					<input v-model="typed" type="text" list="ignored-choices" placeholder="e.g. World-Ti Paper/Drafts" autocomplete="off" data-test="ignored-input" @keydown.enter.prevent="submit" />
				</label>
				<datalist id="ignored-choices">
					<option v-for="c in choices" :key="c" :value="c" />
				</datalist>
				<v-button small :loading="adding" :disabled="adding || typed.trim() === ''" data-test="ignored-add" @click="submit">Ignore folder</v-button>
			</div>
			<p v-if="!readOnly" class="d1-note">Below your own folder, with / between the names. Subfolders are included.</p>
			<p v-if="problem" class="err" role="alert" data-test="ignored-problem">{{ problem }}</p>
		</div>
	</section>
</template>

<style scoped>
.ignored { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.toggle { font-size: var(--fs-sm, 12px); }
.body { display: flex; flex-direction: column; gap: 8px; align-self: stretch; padding: 10px 12px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); }
.body p { margin: 0; }
.err { font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.list li { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; font-size: var(--fs-md, 13px); }
.folder { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; font-weight: 650; }
.owner { color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.add { align-items: flex-end; }
.grow { flex: 1 1 220px; }
</style>
