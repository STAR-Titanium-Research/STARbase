<script setup lang="ts">
// "Invite…": e-mail someone a link to set their password (an account administrator may choose the account role; anyone else invites Lab
// Members). Invited from a person (their panel) the login is linked to that person; from the header a person is made from the full name.
// Wording follows the server's mailer: Directus hands the mail over and does not wait, so this says the invite was SENT, never delivered.
import { computed, ref, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import { PeopleApiError, invite } from './peopleApi';
import type { PeopleRow } from './peopleQuery';

const props = defineProps<{
	modelValue: boolean;
	/** The person being invited; null/undefined = invite from the header (a new person is made from the full name). */
	person?: PeopleRow | null;
	roles: { id: string; name: string }[];
	canAdministerAccounts: boolean;
	/** The list, to name the person an e-mail's login already belongs to. */
	rows?: PeopleRow[];
}>();
const emit = defineEmits<{
	(e: 'update:modelValue', open: boolean): void;
	(e: 'invited'): void;
	/** "Open <person>": the e-mail already has a login linked to this person. */
	(e: 'open-person', personId: string): void;
}>();

const { api } = useExplorerHost();
const email = ref('');
const fullName = ref('');
const roleId = ref<string | null>(null);
const saving = ref(false);
const err = ref('');
const existingPersonId = ref<string | null>(null);
const sentTo = ref('');
const sentNote = ref('');
const close = () => emit('update:modelValue', false);

const roleItems = computed(() => props.roles.map((r) => ({ text: r.name, value: r.id })));
const labMember = computed(() => props.roles.find((r) => r.name === 'Lab Member')?.id ?? null);
const existingName = computed(() => props.rows?.find((r) => r.person_id === existingPersonId.value)?.full_name ?? null);
const done = computed(() => !!sentTo.value);

// Each time the dialog opens it starts from the person given (or a blank form).
watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		email.value = props.person?.email ?? '';
		fullName.value = '';
		roleId.value = labMember.value;
		err.value = '';
		existingPersonId.value = null;
		sentTo.value = '';
		sentNote.value = '';
	},
	{ immediate: true },
);

async function send() {
	const to = email.value.trim();
	const name = fullName.value.trim();
	if (!to) return void (err.value = 'Enter an e-mail address.');
	if (!props.person && !name) return void (err.value = 'Enter their full name.');
	saving.value = true;
	err.value = '';
	existingPersonId.value = null;
	try {
		const r = await invite(api, {
			email: to,
			// Only an account administrator chooses the role; the server gives everyone else Lab Member.
			...(props.canAdministerAccounts && roleId.value ? { role: roleId.value } : {}),
			...(props.person?.person_id ? { person_id: props.person.person_id } : { full_name: name }),
		});
		sentTo.value = to;
		sentNote.value = r.email_sent ? `Invite sent to ${to}.` : 'The login was created but the email could not be sent — use Resend.';
		emit('invited');
	} catch (e) {
		err.value = e instanceof Error && e.message ? e.message : 'Could not send the invite.';
		if (e instanceof PeopleApiError && e.code === 'EMAIL_HAS_LOGIN' && typeof e.extensions?.person_id === 'string') existingPersonId.value = e.extensions.person_id;
	} finally {
		saving.value = false;
	}
}

function openExisting() {
	if (!existingPersonId.value) return;
	emit('open-person', existingPersonId.value);
	close();
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="invite-card">
			<v-card-title>{{ person ? `Invite ${person.full_name}` : 'Invite someone' }}</v-card-title>
			<v-card-text>
				<template v-if="done">
					<p class="sent" role="status">{{ sentNote }}</p>
				</template>
				<template v-else>
					<div v-if="!person" class="fld"><label>Full name *</label><v-input v-model="fullName" placeholder="First Last" autofocus /></div>
					<div class="fld"><label>E-mail *</label><v-input v-model="email" placeholder="name@sheffield.ac.uk" :autofocus="!!person" /></div>
					<div class="fld">
						<label>Account role</label>
						<v-select v-if="canAdministerAccounts" v-model="roleId" :items="roleItems" />
						<v-input v-else model-value="Lab Member" disabled />
					</div>
					<p class="hint">The invite expires in 7 days.</p>
					<p v-if="err" class="err" role="alert">{{ err }}</p>
					<p v-if="existingPersonId" class="err">
						<button type="button" class="link" @click="openExisting">Open {{ existingName ?? 'that person' }}</button>
					</p>
				</template>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button v-if="done" @click="close">Done</v-button>
				<template v-else>
					<v-button secondary @click="close">Cancel</v-button>
					<v-button :loading="saving" @click="send">Send invite</v-button>
				</template>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.invite-card { width: 460px; max-width: 94vw; }
.fld { margin-bottom: 12px; }
.fld label { display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600; }
.hint { margin: 0 0 6px; font-size: var(--fs-sm, 12px); color: var(--theme--foreground-subdued, #6b7684); }
.sent { margin: 0; }
.spacer { flex: 1; }
.err { color: var(--theme--danger); font-size: 12px; margin: 8px 0 0; }
.link { border: 0; background: transparent; padding: 0; font: inherit; font-weight: 600; color: inherit; text-decoration: underline; cursor: pointer; }
</style>
