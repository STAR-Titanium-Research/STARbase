<script setup lang="ts">
// Add a person to a team (people only; teams never contain teams). Search by name, pick one, optionally make them a manager, Add. The
// dialog then stays open and says what the endpoint answered: how many owners will be asked to approve the records already shared with the
// team (the new member is a pending member on those until the owner decides; Ruling D2), and the records the team owns (the member can edit those at once; a manager also acts as their owner). A person with no
// login can be added: they get access the day a login is linked, and the list says so.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { addMember, useExplorerHost, useRequestGate } from '@d1/ui';
import { addedLines } from './teamPage';

interface Hit { person_id: string; full_name: string; user_id: string | null }

const props = defineProps<{ modelValue: boolean; team: { team_id: string; name: string }; memberIds: string[] }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'added'): void }>();

const host = useExplorerHost();
const gate = useRequestGate();
const text = ref('');
const hits = ref<Hit[]>([]);
const searching = ref(false);
const searchError = ref('');
const picked = ref<Hit | null>(null);
const asManager = ref(false);
const saving = ref(false);
const err = ref('');
const result = ref<string[] | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

const close = () => emit('update:modelValue', false);
const shown = computed(() => hits.value.filter((h) => !props.memberIds.includes(h.person_id)));

watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		text.value = '';
		hits.value = [];
		picked.value = null;
		asManager.value = false;
		err.value = '';
		searchError.value = '';
		result.value = null;
	},
	{ immediate: true },
);

watch(text, (value) => {
	if (timer) clearTimeout(timer);
	searchError.value = '';
	if (!value.trim()) {
		gate.cancel();
		hits.value = [];
		searching.value = false;
		return;
	}
	searching.value = true;
	timer = setTimeout(async () => {
		const token = gate.begin();
		try {
			const filter = { _and: [{ active: { _eq: true } }, { full_name: { _icontains: value.trim() } }] };
			const res = await host.api.get('/items/people', { params: { filter: JSON.stringify(filter), fields: ['person_id', 'full_name', 'user_id'], sort: ['full_name'], limit: 8 } });
			if (!gate.isCurrent(token)) return;
			hits.value = (res.data?.data ?? []) as Hit[];
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			hits.value = [];
			searchError.value = e?.message || 'Could not search people.';
		} finally {
			if (gate.isCurrent(token)) searching.value = false;
		}
	}, 250);
});
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	gate.cancel();
});

const pick = (h: Hit) => {
	picked.value = h;
	text.value = '';
	hits.value = [];
};

async function add() {
	const p = picked.value;
	if (!p) return;
	saving.value = true;
	err.value = '';
	try {
		const r = await addMember(host.api, props.team.team_id, p.person_id, asManager.value);
		const lines = addedLines(p.full_name, props.team.name, r, asManager.value);
		if (!p.user_id) lines.push(`${p.full_name} has no login yet; the access starts working when an administrator links one.`);
		result.value = lines;
		picked.value = null;
		emit('added');
	} catch (e: any) {
		err.value = e?.message || 'Could not add the member.';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="add-card">
			<v-card-title>Add a member to {{ team.name }}</v-card-title>
			<v-card-text>
				<template v-if="!result">
					<div v-if="!picked" class="fld">
						<label>Person</label>
						<v-input v-model="text" placeholder="Search people by name…" autofocus />
						<p v-if="searchError" class="err" role="alert">{{ searchError }}</p>
						<ul v-if="shown.length" class="hits" aria-label="People">
							<li v-for="h in shown" :key="h.person_id">
								<button type="button" class="hit" @click="pick(h)">{{ h.full_name }}<span v-if="!h.user_id" class="tag">can't sign in yet</span></button>
							</li>
						</ul>
						<p v-else-if="text.trim() && !searching && !searchError" class="hint">No one else matches.</p>
					</div>
					<div v-else class="fld">
						<label>Person</label>
						<div class="chosen">
							<strong>{{ picked.full_name }}</strong><span v-if="!picked.user_id" class="tag">can't sign in yet</span>
							<button type="button" class="link" @click="picked = null">Change</button>
						</div>
						<label class="tg"><v-checkbox v-model="asManager" /> Make manager</label>
					</div>
					<p class="hint">Owners of records already shared with {{ team.name }} are asked to approve the new member; nothing changes for them until they do. On the records {{ team.name }} owns, a new member can edit at once, and a manager can also share, transfer and delete them.</p>
					<p v-if="err" class="err" role="alert">{{ err }}</p>
				</template>
				<div v-else role="status">
					<p v-for="l in result" :key="l" class="line">{{ l }}</p>
				</div>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<template v-if="!result">
					<v-button secondary @click="close">Cancel</v-button>
					<v-button :disabled="!picked" :loading="saving" @click="add">Add member</v-button>
				</template>
				<v-button v-else @click="close">Done</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.add-card { width: min(480px, calc(100vw - 24px)); }
.fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.fld label { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.fld .tg { display: flex; align-items: center; gap: 6px; font-weight: 400; color: var(--theme--foreground); }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.line { margin: 0 0 8px; }
.spacer { flex: 1; }
.hits { list-style: none; margin: 0; padding: 4px 0; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); max-height: 220px; overflow: auto; }
.hit { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 12px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.hit:hover, .hit:focus-visible { background: var(--d1-tile); outline: none; }
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); }
.chosen { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; cursor: pointer; }
</style>
