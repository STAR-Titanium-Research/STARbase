<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import './tokens.css';
import { EXPLORER_HOST } from '../host';
import { useAccess } from '../access/useAccess';
import {
	LOGINLESS_NOTE, RESTRICT_UI, ROLE_LABELS, blockedText, canChangeRole, entryLabel, initials, isLoginless, noManagerText, ownerWord, piNote,
	recordWord, sortEntries, sortTeams, teamMembersLabel, isTeamHit, transferConfirmText, type AccessEntry, type PersonHit, type TeamHit,
} from '../access/accessModel';
import AccessPersonPicker from './AccessPersonPicker.vue';
import AccessTeamRow from './AccessTeamRow.vue';
import TeamTile from '../teams/TeamTile.vue';

// "Who has access": a Google Drive "Manage members" style dialog on the record pages (spec section 1). Everyone who can read the record
// sees the list; the controls (add, role, remove, transfer) are drawn only for the owner (the PI for a project) and admins, and
// everyone else reads "Only <owner> can change who has access." Operations and tests on an unrestricted sample also show who
// can see them through the sample (`parent`), read-only. Teams are added like people (the add box searches both) and listed with their
// tile, member count and a members card; a manager of the record can trust future members and approve or decline joiners who wait
// (AccessTeamRow). It talks to /d1-record-access through the host's api, so the kit stays
// host-neutral. The page behind it is told (`changed`) after every write.
//
// Keyboard: Escape closes (a first Escape closes an open name list), Tab cycles inside the dialog, focus goes back to whatever had it.
const props = withDefaults(
	defineProps<{
		modelValue: boolean;
		collection: string;
		id: string;
		title?: string;
		/** The record this one inherits from: an operation or test passes its sample. */
		parent?: { collection: string; id: string; label?: string } | null;
		/** The Restrict switch. One constant (RESTRICT_UI) feeds it; it is off in A1a. */
		restrictEnabled?: boolean;
	}>(),
	{ title: '', parent: null, restrictEnabled: RESTRICT_UI },
);
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'changed'): void }>();

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('AccessDialog needs an ExplorerHost: render it inside ExplorerView');

const access = useAccess(host.api, () => ({ collection: props.collection, id: props.id, parent: props.parent }), () => emit('changed'));
const { list, parentList, loading, busy, error, note } = access;

const uid = `d1-access-${Math.random().toString(36).slice(2, 8)}`;
const dialog = ref<HTMLElement | null>(null);
const done = ref<HTMLButtonElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const addBox = ref<InstanceType<typeof AccessPersonPicker> | null>(null);
const transferBox = ref<InstanceType<typeof AccessPersonPicker> | null>(null);
let opener: HTMLElement | null = null;

const canManage = computed(() => list.value?.can_manage === true);
const word = computed(() => recordWord(props.collection));
const roles = computed(() => ROLE_LABELS(props.collection));
const entries = computed(() => sortEntries(list.value?.entries ?? []));
const teams = computed(() => sortTeams(list.value?.teams ?? []));
const parentEntries = computed(() => sortEntries(parentList.value?.entries ?? []));
const pi = computed(() => (list.value ? piNote(list.value, props.collection) : null));

// Add: pick a person or a team, choose a role (default Can view), Add.
const picked = ref<PersonHit | TeamHit | null>(null);
const pickedPerson = computed(() => (picked.value && !isTeamHit(picked.value) ? picked.value : null));
const pickedTeam = computed(() => (picked.value && isTeamHit(picked.value) ? picked.value : null));
const pickedRole = ref('view');
// Transfer: choose the new owner, read the confirm text, Confirm.
const transferring = ref(false);
const transferTarget = ref<PersonHit | null>(null);
const confirmText = computed(() =>
	transferTarget.value
		? transferConfirmText(list.value?.owner?.name ?? null, transferTarget.value.full_name, props.collection, !host.isAdmin.value)
		: '',
);

function reset() {
	picked.value = null;
	pickedRole.value = 'view';
	transferring.value = false;
	transferTarget.value = null;
}

watch(
	() => [props.modelValue, props.collection, props.id],
	async () => {
		if (!props.modelValue) {
			access.cancel();
			return;
		}
		opener = document.activeElement as HTMLElement | null;
		reset();
		await access.load();
		await nextTick();
		(addBox.value ?? done.value)?.focus?.();
	},
	{ immediate: true },
);
onBeforeUnmount(() => access.cancel());

function close() {
	emit('update:modelValue', false);
	if (opener?.isConnected) void nextTick(() => opener?.focus());
}

// After a write the control that had focus (Remove, Add, Confirm) is gone: keep focus inside the dialog, on the add box when there is
// one, else on the heading, so a keyboard or screen-reader user is not dropped on the page behind.
async function refocus() {
	await nextTick();
	(addBox.value?.focus ? addBox.value : heading.value)?.focus?.();
}
async function addPicked() {
	if (!picked.value || busy.value) return;
	const done = isTeamHit(picked.value) ? await access.addTeam(picked.value.team_id, pickedRole.value) : await access.add(picked.value.person_id, pickedRole.value);
	if (done) reset();
	await refocus();
}
// A decision removes the button that had focus. Keep focus on the team's next Approve / Decline (or its "N waiting" button) when it still
// exists, else on the add box, so a keyboard user is not dropped on the page behind.
async function decideJoiner(teamId: string, personId: string, decision: 'approve' | 'decline') {
	await access.decide(teamId, personId, decision);
	await nextTick();
	const at = document.activeElement;
	if (at && at !== document.body && dialog.value?.contains(at)) return;
	const next = dialog.value?.querySelector<HTMLElement>(`[data-team-id="${teamId.replace(/[\\"]/g, "")}"] :is(.joiners button, .backlog)`);
	if (next) next.focus();
	else await refocus();
}
async function removeTeam(teamId: string) {
	if (busy.value) return;
	await access.removeTeam(teamId);
	await refocus();
}
async function confirmTransfer() {
	if (!transferTarget.value || busy.value) return;
	if (await access.transferTo(transferTarget.value.person_id)) reset();
	await refocus();
}
async function removeEntry(entry: AccessEntry) {
	if (!entry.person_id || busy.value) return;
	await access.remove(entry.person_id);
	await refocus();
}
function onRole(entry: AccessEntry, ev: Event) {
	if (entry.person_id) void access.changeRole(entry.person_id, (ev.target as HTMLSelectElement).value);
}
function startTransfer() {
	transferring.value = true;
	transferTarget.value = null;
	void nextTick(() => transferBox.value?.focus());
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		close();
	} else if (e.key === 'Tab') {
		const stops = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])') ?? []);
		if (!stops.length) return;
		const first = stops[0];
		const last = stops[stops.length - 1];
		const at = document.activeElement as HTMLElement | null;
		if (e.shiftKey && (at === first || !dialog.value?.contains(at))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (at === last || !dialog.value?.contains(at))) {
			e.preventDefault();
			first.focus();
		}
	}
}
</script>

<template>
	<Teleport to="body">
		<div v-if="modelValue" class="d1-kit d1-access-backdrop" @mousedown.self="close">
			<div ref="dialog" class="d1-access" role="dialog" aria-modal="true" :aria-labelledby="`${uid}-title`" @keydown="onKeydown">
				<header class="top">
					<h2 :id="`${uid}-title`" ref="heading" tabindex="-1">Who has access to <span class="rec">{{ title || `this ${word}` }}</span></h2>
					<button type="button" class="x" aria-label="Close" @click="close">&times;</button>
				</header>

				<div class="body">
					<p v-if="loading" class="hint" role="status">Loading…</p>
					<p v-else-if="error && !list" class="err" role="alert">{{ error }}</p>

					<template v-if="list">
						<p v-if="!canManage" class="hint quiet">{{ noManagerText(list.owner) }}</p>

						<label v-if="restrictEnabled && canManage" class="restrict">
							<input type="checkbox" :checked="list.restricted" :disabled="busy" @change="access.setRestricted(($event.target as HTMLInputElement).checked)" />
							Restricted: only the people below can see this
						</label>

						<div v-if="canManage && !transferring" class="add">
							<AccessPersonPicker ref="addBox" :list="list" teams label="Add people or teams by name" placeholder="Add people or teams" :disabled="busy" @pick="(p: PersonHit | TeamHit) => (picked = p)" />
						</div>
						<div v-if="canManage && pickedPerson && !transferring" class="picked">
							<span class="who"><b>{{ pickedPerson.full_name }}</b><span v-if="isLoginless(pickedPerson)" class="tag">{{ LOGINLESS_NOTE }}</span></span>
							<select v-model="pickedRole" :aria-label="`Role for ${pickedPerson.full_name}`" :disabled="busy">
								<option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
							</select>
							<button type="button" class="btn primary" :disabled="busy" @click="addPicked">Add</button>
							<button type="button" class="btn" :disabled="busy" @click="picked = null">Cancel</button>
							<p v-if="isLoginless(pickedPerson)" class="hint full">They are added now, and the access starts working the day an admin links their login to their People record.</p>
						</div>
						<div v-if="canManage && pickedTeam && !transferring" class="picked">
							<span class="who team-pick"><TeamTile :team="pickedTeam" size="sm" /><b>{{ pickedTeam.name }}</b><span class="hint">{{ teamMembersLabel(pickedTeam.member_count) }}</span></span>
							<select v-model="pickedRole" :aria-label="`Level for the team ${pickedTeam.name}`" :disabled="busy">
								<option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
							</select>
							<button type="button" class="btn primary" :disabled="busy" @click="addPicked">Add</button>
							<button type="button" class="btn" :disabled="busy" @click="picked = null">Cancel</button>
							<p class="hint full">Everyone in the team gets this access now. Someone who joins the team later waits for an owner's approval, unless you choose Trust future members.</p>
						</div>

						<p v-if="error" class="err" role="alert">{{ error }}</p>
						<p v-else-if="note" class="hint quiet" role="status" aria-live="polite">{{ note }}</p>

						<ul class="rows" :aria-label="`People with access to this ${word}`">
							<li class="row owner">
								<span class="av" aria-hidden="true">{{ list.owner ? initials(list.owner.name) : '?' }}</span>
								<span class="who">
									<span class="name">{{ list.owner ? list.owner.name : 'No owner' }}</span>
									<span v-if="list.owner && !list.owner.can_sign_in" class="tag">{{ LOGINLESS_NOTE }}</span>
								</span>
								<span class="role">{{ ownerWord(collection) }}</span>
							</li>
							<AccessTeamRow
								v-for="t in teams"
								:key="t.team_id"
								:team="t"
								:can-manage="canManage"
								:busy="busy"
								:roles="roles"
								:members="access.teamMembers.value[t.team_id] ?? null"
								@role="(role: string) => access.changeTeam(t.team_id, { role })"
								@trust="(value: boolean) => access.changeTeam(t.team_id, { trust_new_members: value })"
								@remove="removeTeam(t.team_id)"
								@expand="access.loadMembers(t.team_id)"
								:data-team-id="t.team_id"
								@decide="(personId: string, decision: 'approve' | 'decline') => decideJoiner(t.team_id, personId, decision)"
							/>
							<li v-for="e in entries" :key="e.person_id ?? `login-${e.name}`" class="row">
								<span class="av" aria-hidden="true">{{ initials(e.name) }}</span>
								<span class="who">
									<span class="name">{{ e.name }}</span>
									<span v-if="!e.can_sign_in" class="tag">{{ LOGINLESS_NOTE }}</span>
									<span v-if="canManage && !e.person_id" class="tag">earlier entry with no People record, so it cannot be changed here</span>
									<span v-if="blockedText(e)" class="warn">{{ blockedText(e) }}</span>
								</span>
								<template v-if="canChangeRole(e, canManage)">
									<select :value="e.role" :aria-label="`Role of ${e.name}`" :disabled="busy" @change="onRole(e, $event)">
										<option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
									</select>
									<button type="button" class="btn" :aria-label="`Remove ${e.name}`" :disabled="busy" @click="removeEntry(e)">Remove</button>
								</template>
								<span v-else class="role">{{ entryLabel(e, collection) }}</span>
							</li>
							<li v-if="!entries.length && !teams.length" class="row empty">Nobody else has been added.</li>
						</ul>

						<section v-if="parentList" class="inherited">
							<h3>Also through {{ parent?.label || 'the sample' }}</h3>
							<p class="hint">The people listed on the sample can see this {{ word }} too, unless a campaign or project hides it from them. Change it on the sample.</p>
							<ul class="rows" :aria-label="`People with access through the sample`">
								<li v-if="parentList.owner" class="row">
									<span class="av" aria-hidden="true">{{ initials(parentList.owner.name) }}</span>
									<span class="who"><span class="name">{{ parentList.owner.name }}</span></span>
									<span class="role">Owner</span>
								</li>
								<li v-for="e in parentEntries" :key="e.person_id ?? `plogin-${e.name}`" class="row">
									<span class="av" aria-hidden="true">{{ initials(e.name) }}</span>
									<span class="who"><span class="name">{{ e.name }}</span></span>
									<span class="role">{{ entryLabel(e, parent?.collection ?? 'physical_samples') }}</span>
								</li>
							</ul>
						</section>

						<p v-if="pi" class="hint">{{ pi }}</p>

						<section v-if="canManage && transferring" class="transfer">
							<h3>Transfer ownership</h3>
							<template v-if="!transferTarget">
								<p class="hint">Choose the new {{ collection === 'projects' ? 'principal investigator' : 'owner' }}.</p>
								<AccessPersonPicker ref="transferBox" :list="list" :entries="false" label="New owner, by name" placeholder="Search by name…" :disabled="busy" @pick="(p: PersonHit | TeamHit) => { if (!isTeamHit(p)) transferTarget = p; }" />
							</template>
							<template v-else>
								<p class="confirm" role="status">{{ confirmText }}</p>
								<span v-if="transferTarget && isLoginless(transferTarget)" class="hint">{{ transferTarget.full_name }} {{ LOGINLESS_NOTE }}, so nobody can act as the owner until an admin links their login.</span>
							</template>
							<div class="actions">
								<button v-if="transferTarget" type="button" class="btn primary" :disabled="busy" @click="confirmTransfer">Confirm transfer</button>
								<button v-if="transferTarget" type="button" class="btn" :disabled="busy" @click="transferTarget = null">Back</button>
								<button type="button" class="btn" :disabled="busy" @click="reset">Cancel</button>
							</div>
						</section>
					</template>
				</div>

				<footer class="foot">
					<button v-if="canManage && !transferring" type="button" class="btn" :disabled="busy" @click="startTransfer">Transfer ownership…</button>
					<span class="grow" />
					<button ref="done" type="button" class="btn primary" @click="close">Done</button>
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.d1-access-backdrop {
	position: fixed; inset: 0; z-index: 9999; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
	background: rgba(0, 0, 0, 0.4); font-family: var(--theme--fonts--sans--font-family, inherit); color: var(--theme--foreground);
}
.d1-access {
	width: min(580px, 100%); max-height: 84vh; display: flex; flex-direction: column;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius); background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); overflow: hidden;
}
.top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--d1-line); }
.top h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-lg, 15px); font-weight: 600; }
.top h2:focus { outline: none; }
.rec { overflow-wrap: anywhere; }
.x { border: 0; background: transparent; color: inherit; font-size: 22px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover { background: var(--d1-tile); }
.body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.add { display: flex; gap: 8px; }
.picked { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); }
.picked .who { flex: 1; min-width: 120px; }
.team-pick { align-items: center; gap: 8px; }
.full { flex-basis: 100%; margin: 0; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--d1-line); font-size: var(--fs-md, 13px); }
.row:first-child { border-top: 0; }
.row.empty { color: var(--d1-dim); }
.av {
	flex: 0 0 auto; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%;
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 18%, transparent); font-size: var(--fs-xs, 11px); font-weight: 700;
}
.who { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.role { color: var(--d1-dim); white-space: nowrap; }
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); }
.warn { flex-basis: 100%; font-size: var(--fs-sm, 12px); color: var(--d1-warn); }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.quiet { font-size: var(--fs-md, 13px); }
.err { margin: 0; font-size: var(--fs-md, 13px); color: var(--d1-bad); }
.restrict { display: flex; align-items: center; gap: 8px; font-size: var(--fs-md, 13px); }
.inherited h3, .transfer h3 { margin: 0 0 4px; font-size: var(--fs-md, 13px); font-weight: 700; }
.transfer { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--d1-line); border-radius: 8px; }
.confirm { margin: 0; font-size: var(--fs-md, 13px); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--d1-line); }
.grow { flex: 1; }
select {
	height: 32px; padding: 0 8px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-md, 13px);
}
.btn {
	height: 32px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.btn:disabled, select:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
