<script setup lang="ts">
// Add a person, or (read-only for a member, editable for an administrator) open one. Moved out of people.vue unchanged in behaviour:
// a member can edit only their OWN row (the server refuses the rest), anyone may add a person, only an admin links a login.
import { computed, ref, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import { ALIAS_HINT, FOLDER_CHANGE_NOTE, FORMER_HINT, folderSaveError, isDuplicate } from '../inbox/folderModel';
import { createPersonFolder } from './personFolder';
import type { PeopleRow } from './peopleQuery';

interface Person {
	person_id?: string;
	full_name: string;
	email: string | null;
	user_id: string | null;
	is_researcher: boolean;
	is_operator: boolean;
	active: boolean;
	notes: string | null;
}
interface Opt { text: string; value: string }

const props = defineProps<{ modelValue: boolean; person: PeopleRow | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'saved'): void }>();

const host = useExplorerHost();
const api = host.api;
const { isAdmin } = host;

const users = ref<Opt[]>([]);
// The inbox crawler's fields (uni alias, scan while Former): administrators only, see personFolder.ts.
const folder = createPersonFolder(api);
const { alias, scanFormer } = folder;
const saving = ref(false);
const err = ref('');
const draft = ref<Person>(blank());
const isNew = computed(() => !draft.value.person_id);
const canEditDraft = computed(() => isNew.value || isAdmin.value || (!!host.user.value?.id && draft.value.user_id === host.user.value.id));
const close = () => emit('update:modelValue', false);

function blank(): Person {
	return { full_name: '', email: null, user_id: null, is_researcher: true, is_operator: false, active: true, notes: null };
}
const fromRow = (r: PeopleRow): Person => ({
	person_id: r.person_id ?? undefined,
	full_name: r.full_name,
	email: r.email,
	user_id: r.user_id,
	is_researcher: r.is_researcher,
	is_operator: r.is_operator,
	active: r.active,
	notes: r.notes,
});

// The login list is only needed by the admin-only login picker. isAdmin starts as a guess and can turn true after the page has loaded.
async function loadUsers() {
	if (!isAdmin.value) return;
	try {
		const ur = await api.get('/users', { params: { limit: -1, fields: ['id', 'first_name', 'last_name', 'email'], sort: ['first_name'] } });
		users.value = (ur?.data?.data ?? []).map((u: any) => ({
			text: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || u.id,
			value: u.id,
		}));
	} catch {
		users.value = [];
	}
}

// Each time the dialog opens it starts from the person given (or a blank one).
watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		draft.value = props.person ? fromRow(props.person) : blank();
		err.value = '';
		folder.reset(!!props.person?.person_id);
		if (props.person?.person_id && isAdmin.value) void folder.load(props.person.person_id);
		if (!users.value.length) void loadUsers();
	},
	{ immediate: true },
);

async function save() {
	if (!draft.value.full_name.trim()) { err.value = 'Name is required.'; return; }
	if (isAdmin.value && folder.issue.value) { err.value = folder.issue.value; return; }
	saving.value = true;
	err.value = '';
	// What an existing person's save adds for the inbox crawler's fields: only what changed, and only for an administrator.
	const folderChanges = isAdmin.value && !isNew.value ? folder.changes() : {};
	try {
		const body: Record<string, unknown> = {
			full_name: draft.value.full_name.trim(),
			email: draft.value.email || null,
			is_researcher: draft.value.is_researcher,
			is_operator: draft.value.is_operator,
			active: draft.value.active,
			notes: draft.value.notes || null,
		};
		// Members never send the login: the server refuses a change to it.
		if (isAdmin.value) body.user_id = draft.value.user_id || null;
		if (isNew.value) {
			// The alias is never part of the create (the database refuses one on insert): the person is made first, then the fields are set.
			const created = await api.post('/items/people', body);
			const personId = created?.data?.data?.person_id;
			const failure = isAdmin.value ? await folder.afterCreate(personId, draft.value.full_name.trim()) : null;
			if (failure) {
				// The person exists: the dialog stays open on them, and the list learns of them.
				if (typeof personId === 'string') draft.value = { ...draft.value, person_id: personId };
				err.value = failure;
				emit('saved');
				return;
			}
		} else {
			await api.patch(`/items/people/${draft.value.person_id}`, { ...body, ...folderChanges });
		}
		close();
		emit('saved');
	} catch (e: any) {
		// A unique violation on a save that changed the alias can only be the alias: say so, naming no one.
		err.value = 'uni_alias' in folderChanges && isDuplicate(e)
			? folderSaveError(e, 'alias', 'Could not save.')
			: e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not save.';
	} finally {
		saving.value = false;
	}
}

async function remove() {
	if (!draft.value.person_id) return;
	if (!confirm(`Delete ${draft.value.full_name}? This is permanent. (Use "Former" instead if they just left.)`)) return;
	saving.value = true;
	try {
		await api.delete(`/items/people/${draft.value.person_id}`);
		close();
		emit('saved');
	} catch (e: any) {
		err.value = e?.response?.data?.errors?.[0]?.message || 'Could not delete (they may be referenced by records — mark Former instead).';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="edit-card">
			<v-card-title>{{ isNew ? 'Add a person' : draft.full_name }}</v-card-title>
			<v-card-text>
				<div class="fld"><label>Full name *</label><v-input v-model="draft.full_name" placeholder="First Last" autofocus /></div>
				<div class="row">
					<div class="fld"><label>Email</label><v-input v-model="draft.email" placeholder="name@sheffield.ac.uk" /></div>
					<div class="fld"><label>Login (optional)</label>
						<v-select v-if="isAdmin" v-model="draft.user_id" :items="users" placeholder="No login" show-deselect />
						<template v-else>
							<v-input :model-value="draft.user_id ? 'Linked to a login' : 'No login'" disabled />
							<span class="hint">An admin links logins.</span>
						</template>
					</div>
				</div>
				<div class="toggles">
					<label class="tg"><v-checkbox v-model="draft.is_researcher" /> Researcher</label>
					<label class="tg"><v-checkbox v-model="draft.is_operator" /> Operator / technician</label>
					<label class="tg"><v-checkbox v-model="draft.active" /> Active <span class="hint">(uncheck if they've left the group)</span></label>
				</div>
				<div v-if="isAdmin" class="folder" data-test="person-folder">
					<div class="fld">
						<label for="person-alias">Uni alias</label>
						<input id="person-alias" v-model="alias" class="plain" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. ab1cd" :disabled="!folder.ready.value" :aria-invalid="!!folder.issue.value" data-test="person-alias" />
						<span class="hint">{{ ALIAS_HINT }}</span>
						<span v-if="folder.issue.value" class="err" role="alert" data-test="person-alias-issue">{{ folder.issue.value }}</span>
						<span class="hint warn" data-test="person-alias-note">{{ FOLDER_CHANGE_NOTE }}</span>
						<span v-if="folder.loadError.value" class="err" role="alert">{{ folder.loadError.value }}</span>
					</div>
					<label class="tg"><input v-model="scanFormer" type="checkbox" role="switch" :disabled="!folder.ready.value" data-test="person-scan-former" /> Scan while Former <span class="hint">{{ FORMER_HINT }}</span></label>
				</div>
				<div class="fld"><label>Notes</label><v-textarea v-model="draft.notes" placeholder="Optional" /></div>
				<p v-if="!canEditDraft" class="hint">You can only change your own entry. An admin can edit anyone's.</p>
				<p v-if="err" class="err">{{ err }}</p>
			</v-card-text>
			<v-card-actions>
				<v-button v-if="!isNew && isAdmin" secondary class="del" :loading="saving" @click="remove"><v-icon name="delete" left small />Delete</v-button>
				<div class="spacer" />
				<v-button secondary @click="close">Cancel</v-button>
				<v-button :loading="saving" :disabled="!canEditDraft" @click="save">{{ isNew ? 'Add person' : 'Save' }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.edit-card { width: 520px; max-width: 94vw; }
.edit-card .fld { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.edit-card .fld label { font-size: 12px; font-weight: 600; color: var(--theme--foreground-subdued, #6b7684); }
.edit-card .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.toggles { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 14px; }
.tg { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.tg .hint { font-weight: 400; color: var(--theme--foreground-subdued, #94a3b8); font-size: 11px; }
.edit-card .fld > .hint { font-size: 11px; color: var(--theme--foreground-subdued, #94a3b8); }
.spacer { flex: 1; }
.folder { margin: 4px 0 8px; padding: 10px 0 0; border-top: 1px solid var(--theme--border-color-subdued, #e5e7eb); }
.plain {
	height: 36px; padding: 0 10px; box-sizing: border-box; border: 1px solid var(--theme--border-color, #d1d5db); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground); font: inherit;
}
.plain[aria-invalid='true'] { border-color: var(--theme--danger); }
.edit-card .fld > .hint.warn { color: var(--theme--warning, #b45309); }
.edit-card .fld > .err { font-size: 12px; }
.del { --v-button-color: var(--theme--danger); }
.err { color: var(--theme--danger); font-size: 12px; margin: 6px 0 0; }
</style>
