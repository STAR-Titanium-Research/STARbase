<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { PageShell } from '@d1/ui';

const api = useApi();
const router = useRouter();
const userStore = useStores().useUserStore() as any;
// Only an admin may link a login to a People row (ADR-0011: the link decides whose records a
// person sees, so a member relinking it would inherit someone else's records). Directus keeps the
// admin flag in different places across versions; if a non-admin is wrongly treated as one, the
// server still refuses the write.
const isAdmin = computed(() => {
	const u = userStore.currentUser;
	return Boolean(userStore.isAdmin ?? u?.admin_access ?? u?.role?.admin_access);
});
const go = (to: string) => router.push(to);

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

const people = ref<Person[]>([]);
const users = ref<Opt[]>([]);
const loading = ref(true);
const filter = ref<'all' | 'researchers' | 'operators' | 'former' | 'nologin'>('all');
const q = ref('');

// Edit / add dialog state.
const dialog = ref(false);
const saving = ref(false);
const draft = ref<Person>(blank());
const isNew = computed(() => !draft.value.person_id);
const err = ref('');

function blank(): Person {
	return { full_name: '', email: null, user_id: null, is_researcher: true, is_operator: false, active: true, notes: null };
}

async function load() {
	loading.value = true;
	try {
		// The login list is only needed by the admin-only login picker.
		const [pr, ur] = await Promise.all([
			api.get('/items/people', { params: { limit: -1, sort: ['full_name'] } }),
			isAdmin.value
				? api.get('/users', { params: { limit: -1, fields: ['id', 'first_name', 'last_name', 'email'], sort: ['first_name'] } })
				: Promise.resolve(null),
		]);
		people.value = pr?.data?.data ?? [];
		users.value = (ur?.data?.data ?? []).map((u: any) => ({
			text: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || u.id,
			value: u.id,
		}));
	} finally {
		loading.value = false;
	}
}
onMounted(load);

const tabs = computed(() => [
	{ id: 'all', label: 'Everyone', n: people.value.length },
	{ id: 'researchers', label: 'Researchers', n: people.value.filter((p) => p.is_researcher).length },
	{ id: 'operators', label: 'Operators', n: people.value.filter((p) => p.is_operator).length },
	{ id: 'former', label: 'Former', n: people.value.filter((p) => !p.active).length },
	{ id: 'nologin', label: 'No app login', n: people.value.filter((p) => !p.user_id).length },
]);

const filtered = computed(() => {
	const term = q.value.trim().toLowerCase();
	return people.value.filter((p) => {
		if (filter.value === 'researchers' && !p.is_researcher) return false;
		if (filter.value === 'operators' && !p.is_operator) return false;
		if (filter.value === 'former' && p.active) return false;
		if (filter.value === 'nologin' && p.user_id) return false;
		if (term && !(`${p.full_name} ${p.email ?? ''}`.toLowerCase().includes(term))) return false;
		return true;
	});
});

function roleChips(p: Person): string[] {
	const r: string[] = [];
	if (p.is_researcher) r.push('Researcher');
	if (p.is_operator) r.push('Operator');
	if (!r.length) r.push('—');
	return r;
}

function openAdd() { draft.value = blank(); err.value = ''; dialog.value = true; }
function openEdit(p: Person) { draft.value = { ...p }; err.value = ''; dialog.value = true; }

async function save() {
	if (!draft.value.full_name.trim()) { err.value = 'Name is required.'; return; }
	saving.value = true;
	err.value = '';
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
		if (isNew.value) await api.post('/items/people', body);
		else await api.patch(`/items/people/${draft.value.person_id}`, body);
		dialog.value = false;
		await load();
	} catch (e: any) {
		err.value = e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not save.';
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
		dialog.value = false;
		await load();
	} catch (e: any) {
		err.value = e?.response?.data?.errors?.[0]?.message || 'Could not delete (they may be referenced by records — mark Former instead).';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<private-view title="People">
		<template #headline><span class="crumb" @click="go('/home')">Home</span></template>
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded icon secondary disabled><v-icon name="groups" /></v-button>
		</template>

		<PageShell narrow>
			<!-- No heading of its own: the header bar already says "People". -->
			<div class="intro">
				<p>Everyone attributed on records — researchers, operators, or both. Mark someone <b>Former</b> when they
					leave; add a researcher even if they have no app login.</p>
			</div>

			<div class="bar">
				<div class="tabs">
					<button v-for="t in tabs" :key="t.id" class="tab" :class="{ on: filter === t.id }" @click="filter = t.id as any">
						{{ t.label }} <span class="tn">{{ t.n }}</span>
					</button>
				</div>
				<div class="bar-right">
					<v-input v-model="q" class="search" placeholder="Search name / email…" :small="true">
						<template #prepend><v-icon name="search" small /></template>
					</v-input>
					<v-button small @click="openAdd"><v-icon name="person_add" left small />Add person</v-button>
				</div>
			</div>

			<v-progress-circular v-if="loading" indeterminate class="load" />
			<div v-else-if="!filtered.length" class="empty">No people match.</div>
			<div v-else class="list">
				<button v-for="p in filtered" :key="p.person_id" class="prow" :class="{ former: !p.active }" @click="openEdit(p)">
					<div class="avatar"><v-icon :name="p.is_operator && !p.is_researcher ? 'engineering' : 'person'" /></div>
					<div class="pinfo">
						<div class="pname">{{ p.full_name }}<span v-if="!p.active" class="former-tag">Former</span></div>
						<div class="pmeta">
							<span v-for="r in roleChips(p)" :key="r" class="chip" :class="r.toLowerCase()">{{ r }}</span>
							<span class="chip login" :class="{ off: !p.user_id }">{{ p.user_id ? 'App user' : 'No login' }}</span>
							<span v-if="p.email" class="pemail">{{ p.email }}</span>
						</div>
					</div>
					<v-icon name="chevron_right" class="go" />
				</button>
			</div>
		</PageShell>

		<v-dialog v-model="dialog" @esc="dialog = false">
			<v-card class="edit-card">
				<v-card-title>{{ isNew ? 'Add a person' : draft.full_name }}</v-card-title>
				<v-card-text>
					<div class="fld"><label>Full name *</label><v-input v-model="draft.full_name" placeholder="First Last" autofocus /></div>
					<div class="row">
						<div class="fld"><label>Email</label><v-input v-model="draft.email" placeholder="name@sheffield.ac.uk" /></div>
						<div class="fld"><label>App login (optional)</label>
							<v-select v-if="isAdmin" v-model="draft.user_id" :items="users" placeholder="Not an app user" show-deselect />
							<template v-else>
								<v-input :model-value="draft.user_id ? 'Linked to an app login' : 'No app login'" disabled />
								<span class="hint">An admin links logins.</span>
							</template>
						</div>
					</div>
					<div class="toggles">
						<label class="tg"><v-checkbox v-model="draft.is_researcher" /> Researcher</label>
						<label class="tg"><v-checkbox v-model="draft.is_operator" /> Operator / technician</label>
						<label class="tg"><v-checkbox v-model="draft.active" /> Active <span class="hint">(uncheck if they've left the group)</span></label>
					</div>
					<div class="fld"><label>Notes</label><v-textarea v-model="draft.notes" placeholder="Optional" /></div>
					<p v-if="err" class="err">{{ err }}</p>
				</v-card-text>
				<v-card-actions>
					<v-button v-if="!isNew && isAdmin" secondary class="del" :loading="saving" @click="remove"><v-icon name="delete" left small />Delete</v-button>
					<div class="spacer" />
					<v-button secondary @click="dialog = false">Cancel</v-button>
					<v-button :loading="saving" @click="save">{{ isNew ? 'Add person' : 'Save' }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script lang="ts">
export default { inheritAttrs: false };
</script>

<style scoped>
.crumb { cursor: pointer; }
.intro p { margin: 0; max-width: 72ch; font-size: var(--fs-md); line-height: 1.5; color: var(--d1-dim); }

.bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; }
/* The force app's chip: 26px, a pill, filled with the accent when it is the one chosen. */
.tab { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--d1-line); background: var(--d1-surface); border-radius: 99px;
	font: inherit; font-size: var(--fs-sm); font-weight: 600; line-height: 1; color: var(--d1-dim); cursor: pointer; }
.tab:hover { color: var(--theme--foreground); }
.tab.on { background: var(--d1-accent, var(--theme--primary, #1d4ed8)); border-color: var(--d1-accent, var(--theme--primary, #1d4ed8)); color: var(--d1-on-accent, #fff); }
.tab .tn { opacity: .75; font-weight: 700; margin-left: 5px; font-variant-numeric: tabular-nums; }
.bar-right { display: flex; gap: 8px; align-items: center; }
/* A fixed basis, not only a maximum: free to shrink, the field shrank to its icon and "Se…" and
   the row never wrapped. Now the search and the button drop under the tabs when there is no room. */
.search { flex: 0 0 220px; max-width: 100%; }

.load, .empty { display: block; margin: 40px auto; text-align: center; color: var(--d1-dim); }

/* One panel with a row per person, not a card per person: 40 cards were 40 boxes to read past. */
.list { display: flex; flex-direction: column; background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); overflow: hidden; }
.prow { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; cursor: pointer; font: inherit; color: var(--theme--foreground);
	background: transparent; border: 0; border-top: 1px solid var(--d1-line); padding: 8px 14px; }
.prow:first-child { border-top: 0; }
.prow:hover { background: var(--d1-tile); }
.prow.former { opacity: .62; }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto;
	background: var(--d1-tint); color: var(--d1-accent, var(--theme--primary)); --v-icon-color: var(--d1-accent, var(--theme--primary)); }
.pinfo { flex: 1; min-width: 0; }
.pname { font-weight: 650; font-size: var(--fs-md); display: flex; align-items: center; gap: 8px; }
.former-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--d1-bad);
	background: color-mix(in srgb, var(--theme--danger) 14%, transparent); border-radius: 99px; padding: 1px 8px; }
.pmeta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 3px; }
/* Who someone is, in the theme's own colours (they were fixed pastel hexes, unreadable on a dark
   theme) and at 11px in sentence case (they were 10px capitals). */
.chip { font-size: var(--fs-xs); font-weight: 700; padding: 1px 8px; border-radius: 99px;
	background: var(--theme--background-normal); color: var(--d1-dim); }
.chip.researcher { background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); color: var(--d1-accent, var(--theme--primary)); }
.chip.operator { background: color-mix(in srgb, var(--theme--success) 18%, transparent); color: var(--d1-ok); }
.chip.login { background: transparent; box-shadow: inset 0 0 0 1px var(--theme--border-color); color: var(--theme--foreground); }
.chip.login.off { color: var(--d1-dim); box-shadow: inset 0 0 0 1px var(--d1-line); }
.pemail { font-size: var(--fs-sm); color: var(--d1-dim); }
.go { --v-icon-color: var(--d1-dim); flex: 0 0 auto; }

.edit-card { width: 520px; max-width: 94vw; }
.edit-card .fld { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.edit-card .fld label { font-size: 12px; font-weight: 600; color: var(--theme--foreground-subdued, #6b7684); }
.edit-card .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.toggles { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 14px; }
.tg { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.tg .hint { font-weight: 400; color: var(--theme--foreground-subdued, #94a3b8); font-size: 11px; }
.edit-card .fld > .hint { font-size: 11px; color: var(--theme--foreground-subdued, #94a3b8); }
.spacer { flex: 1; }
.del { --v-button-color: var(--theme--danger); }
.err { color: var(--theme--danger); font-size: 12px; margin: 6px 0 0; }
</style>
