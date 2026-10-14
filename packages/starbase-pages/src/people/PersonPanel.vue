<script setup lang="ts">
// The panel beside the People list (a bottom sheet on a narrow screen): who the person is (Edit opens the person dialog), their Account
// (an administrator's view: role, login, last sign-in) and their Access (three counts; a count opens its records). A member sees their own
// panel without the Account section. Words follow CONTEXT.md: account role, login, Suspended, Former; Researcher / Operator are kinds of work.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RecordLink, useExplorerHost } from '@d1/ui';
import PersonEditDialog from './PersonEditDialog.vue';
import { lastSeen } from './lastSeen';
import {
	loadAccess,
	patchLogin,
	removeDirectGrant,
	resendInvite,
	type AccessList,
	type AccessRecord,
	type PersonAccess,
} from './peopleApi';
import type { PeopleLogin, PeopleRow } from './peopleQuery';
import { ACCESS_LISTS, ESC_OWNER_SELECTOR, canEditRole, countLabel, escapeClosesPanel, kindLabel, levelLabel, loginLine, sourceNote } from './personPanel';

const props = defineProps<{
	personId: string;
	rows: PeopleRow[];
	canAdministerAccounts: boolean;
	roles: { id: string; name: string }[];
}>();
const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'changed'): void;
	(e: 'invite', person: PeopleRow): void;
}>();

const host = useExplorerHost();
const { api, isAdmin } = host;

const listed = computed(() => props.rows.find((r) => r.person_id === props.personId) ?? null);
// What a change just did to the login, shown until the reloaded list says the same (so the select and the line never flick back).
const override = ref<Partial<PeopleLogin> | null>(null);
watch(
	() => [props.rows, props.personId],
	() => (override.value = null),
);
const person = computed<PeopleRow | null>(() => {
	const p = listed.value;
	return p && p.login && override.value ? { ...p, login: { ...p.login, ...override.value } } : p;
});
const initials = computed(
	() =>
		(person.value?.full_name ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?',
);

// ---- Edit: an administrator edits anyone; a member only their own row (the dialog keeps the same rule) ----
const editOpen = ref(false);
const canEdit = computed(() => isAdmin.value || (!!person.value?.user_id && person.value.user_id === host.user.value?.id));

// ---- Account (administrators) ----
const viewer = computed(() => ({ admin: isAdmin.value, accounts: props.canAdministerAccounts }));
const line = computed(() => (person.value ? loginLine(person.value, viewer.value) : null));
const roleEditable = computed(() => !!person.value && canEditRole(person.value, viewer.value));
const roleItems = computed(() => props.roles.map((r) => ({ text: r.name, value: r.id })));
const busy = ref(false);
const accountError = ref('');
const notice = ref('');

async function run(work: () => Promise<void>) {
	busy.value = true;
	accountError.value = '';
	notice.value = '';
	try {
		await work();
	} catch (e: any) {
		accountError.value = e?.message || 'That did not work.';
	} finally {
		busy.value = false;
	}
}
const changeRole = (role: unknown) => {
	const p = person.value;
	if (!p?.user_id || typeof role !== 'string' || role === p.login?.role_id) return;
	void run(async () => {
		const done = await patchLogin(api, p.user_id!, { role });
		override.value = { role_id: done.role_id, role_name: done.role_name };
		emit('changed');
	});
};
function doAction() {
	const p = person.value;
	const a = line.value?.action;
	if (!p || !a) return;
	if (a.kind === 'invite') return emit('invite', p);
	void run(async () => {
		if (a.kind === 'resend') {
			const r = await resendInvite(api, p.user_id!);
			notice.value = r.email_sent ? 'Invite sent again.' : 'The invite could not be e-mailed.';
		} else {
			const done = await patchLogin(api, p.user_id!, { status: a.kind === 'suspend' ? 'suspended' : 'active' });
			override.value = { status: done.status };
		}
		emit('changed');
	});
}

// ---- Access: three counts; a count lists its records ----
const access = ref<PersonAccess | null>(null);
const openList = ref<AccessList | null>(null);
const records = ref<AccessRecord[]>([]);
const listLoading = ref(false);
const accessError = ref('');
let seq = 0;
async function reloadAccess(list: AccessList | null = openList.value) {
	const mine = ++seq;
	accessError.value = '';
	listLoading.value = !!list;
	try {
		const a = await loadAccess(api, props.personId, list ?? undefined);
		if (mine !== seq) return;
		access.value = a;
		records.value = list ? (a.records ?? []) : [];
	} catch (e: any) {
		if (mine === seq) accessError.value = e?.message || 'Could not load access.';
	} finally {
		if (mine === seq) listLoading.value = false;
	}
}
function toggleList(list: AccessList) {
	if (openList.value === list) {
		seq++;
		openList.value = null;
		records.value = [];
		listLoading.value = false;
		return;
	}
	openList.value = list;
	records.value = [];
	void reloadAccess(list);
}
watch(
	() => props.personId,
	() => {
		access.value = null;
		openList.value = null;
		records.value = [];
		accountError.value = '';
		notice.value = '';
		void reloadAccess(null);
	},
	{ immediate: true },
);

const removing = ref('');
const recKey = (r: AccessRecord) => `${r.collection}/${r.id}/${r.source}/${r.level}`;
async function remove(r: AccessRecord) {
	removing.value = recKey(r);
	try {
		await removeDirectGrant(api, r.collection, r.id, props.personId);
		await reloadAccess();
	} catch (e: any) {
		accessError.value = e?.message || 'Could not remove that access.';
	} finally {
		removing.value = '';
	}
}

// ---- Esc closes the panel wherever the focus is (it stays on the row that opened it), unless Esc was meant for something over it ----
// The listener is in the CAPTURE phase on purpose: it reads which overlay is open before any overlay's own Esc handler has run. In the bubble
// phase a select, dialog or menu that handled Esc first could already be gone from the DOM, and the panel would close under it too.
// It never stops propagation, so those handlers (and PeopleView's attention-menu one) still run; the menu is covered by its data-open-menu marker.
const overlayOpen = () =>
	Array.from(document.querySelectorAll<HTMLElement>(ESC_OWNER_SELECTOR)).some((el) => !el.matches('.v-menu-content') || el.getClientRects().length > 0);
const onKey = (e: KeyboardEvent) => {
	if (escapeClosesPanel(e, (document.activeElement as HTMLElement | null)?.tagName, overlayOpen())) emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
	<section v-if="person" class="person-panel" :aria-label="person.full_name">
		<header class="head">
			<span class="av" aria-hidden="true">{{ initials }}</span>
			<div class="who">
				<h2 class="nm">{{ person.full_name }}<span v-if="!person.active" class="former-tag">Former</span></h2>
				<div v-if="person.email" class="em">{{ person.email }}</div>
			</div>
			<button v-if="canEdit" class="edit" type="button" @click="editOpen = true">Edit</button>
			<button class="x" type="button" aria-label="Close" @click="emit('close')">&times;</button>
		</header>

		<section v-if="isAdmin && line" class="sec" aria-label="Account">
			<h3>Account</h3>
			<div class="f">
				<span>Role</span>
				<v-select
					v-if="person.login"
					class="role"
					:model-value="person.login.role_id"
					:items="roleItems"
					:disabled="!roleEditable || busy"
					placeholder="No account role"
					@update:model-value="changeRole"
				/>
				<span v-else class="dim">No login</span>
			</div>
			<div class="f">
				<span>Login</span>
				<span>
					{{ line.state }}
					<template v-if="line.action">
						· <button type="button" class="link" :disabled="busy" @click="doAction">{{ line.action.label }}</button>
					</template>
				</span>
			</div>
			<div class="f">
				<span>Last sign-in</span>
				<span>{{ lastSeen(person.login?.last_access) }}</span>
			</div>
			<p v-if="accountError" class="err" role="alert">{{ accountError }}</p>
			<p v-else-if="notice" class="ok" role="status">{{ notice }}</p>
		</section>

		<section class="sec" aria-label="Access">
			<h3>Access</h3>
			<div v-for="l in ACCESS_LISTS" :key="l.id" class="f">
				<span>{{ l.label }}</span>
				<span v-if="!access" class="dim">…</span>
				<button v-else type="button" class="link" :disabled="!access[l.id]" :aria-expanded="openList === l.id" @click="toggleList(l.id)">
					{{ countLabel(access[l.id]) }}
				</button>
			</div>
			<p v-if="accessError" class="err" role="alert">{{ accessError }}</p>
			<div v-if="openList" class="recs">
				<v-progress-circular v-if="listLoading" indeterminate small />
				<p v-else-if="!records.length" class="dim">Nothing to show here.</p>
				<ul v-else>
					<li v-for="r in records" :key="recKey(r)">
						<span class="kind">{{ kindLabel(r.kind) }}</span>
						<span class="what">
							<RecordLink :collection="r.collection" :id="r.id" class="code">{{ r.code || r.title || kindLabel(r.kind) }}</RecordLink>
							<span v-if="r.title && r.code" class="ttl">{{ r.title }}</span>
							<span class="lvl">
								{{ levelLabel(r.level) }}<template v-if="r.granted_by"> · granted by {{ r.granted_by }}</template>
							</span>
						</span>
						<template v-for="n in [sourceNote(r, isAdmin)]" :key="'n'">
							<button
								v-if="n && n.remove"
								type="button"
								class="link"
								:disabled="removing === recKey(r)"
								:aria-label="`Remove ${person.full_name}'s access to ${r.code || r.title || 'this record'}`"
								@click="remove(r)"
							>
								Remove
							</button>
							<span v-else-if="n" class="dim note">{{ n.text }}</span>
						</template>
					</li>
				</ul>
			</div>
		</section>

		<PersonEditDialog v-model="editOpen" :person="person" @saved="emit('changed')" />
	</section>
</template>

<style scoped>
.person-panel { background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); }
.head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.av { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto; font-weight: 700;
	background: var(--d1-tint); color: var(--d1-accent, var(--theme--primary)); }
.who { flex: 1; min-width: 0; }
.nm { margin: 0; font-size: var(--fs-lg); font-weight: 650; overflow-wrap: anywhere; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.former-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--d1-bad);
	background: color-mix(in srgb, var(--theme--danger) 14%, transparent); border-radius: 99px; padding: 1px 8px; }
.em { font-size: var(--fs-sm); color: var(--d1-dim); overflow-wrap: anywhere; }
.edit { flex: 0 0 auto; border: 1px solid var(--d1-line); background: var(--d1-surface); color: var(--theme--foreground); border-radius: var(--d1-radius);
	height: 28px; padding: 0 12px; font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
.edit:hover { background: var(--d1-tile); }
.x { flex: 0 0 auto; width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--d1-dim);
	font-size: 20px; line-height: 1; cursor: pointer; }
.x:hover { background: var(--d1-tile); color: var(--theme--foreground); }

.sec { padding: 4px 16px 14px; }
h3 { margin: 12px 0 4px; font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); }
.f { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; border-top: 1px solid var(--d1-line); font-size: var(--fs-md); }
.f:first-of-type { border-top: 0; }
.f > span:first-child { color: var(--d1-dim); flex: 0 0 auto; }
.role { width: auto; min-width: 0; flex: 0 1 180px; min-height: 28px; font-size: var(--fs-sm); }

.link { border: 0; background: transparent; padding: 0; font: inherit; font-weight: 600; color: var(--d1-accent, var(--theme--primary)); cursor: pointer; }
.link:hover:not(:disabled) { text-decoration: underline; }
.link:disabled { color: var(--d1-dim); cursor: default; font-weight: 400; }
.dim { color: var(--d1-dim); font-size: var(--fs-sm); }
.err { margin: 8px 0 0; font-size: var(--fs-sm); color: var(--d1-bad); overflow-wrap: anywhere; }
.ok { margin: 8px 0 0; font-size: var(--fs-sm); color: var(--d1-dim); }

.recs { margin-top: 6px; border-top: 1px solid var(--d1-line); }
.recs ul { list-style: none; margin: 0; padding: 0; }
.recs li { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-top: 1px solid var(--d1-line); font-size: var(--fs-sm); flex-wrap: wrap; }
.recs li:first-child { border-top: 0; }
.kind { flex: 0 0 auto; font-size: var(--fs-xs); font-weight: 700; color: var(--d1-dim); background: var(--d1-tile); border-radius: 99px; padding: 1px 8px; }
.what { flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 1px; overflow-wrap: anywhere; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.ttl { color: var(--theme--foreground); }
.lvl { color: var(--d1-dim); }
.note { flex: 0 0 auto; }
</style>
