<script setup lang="ts">
// The target step of Change owner (a person), Share or change access and Remove access (a person or a team): the Who has access
// dialog's search box, which empties itself after a pick, so the pick is written below it with a Change button; and, for Share, the
// access level. Choosing a target starts the dry run; so does changing the level.
import { computed, nextTick, ref } from 'vue';
import AccessPersonPicker from '../components/AccessPersonPicker.vue';
import { hitName, isTeamHit } from '../access/accessModel';
import type { PersonHit, TeamHit } from '../access/accessModel';
import type { IndexDef } from '../index/indexConfig';
import type { AccessKind, AccessRole } from './bulkWords';
import { roleChoices, targetKindOf, takesRole } from './bulkWords';
import type { BulkState } from './useBulkActions';

const props = defineProps<{ bulk: BulkState; def: IndexDef; kind: AccessKind }>();

const teams = computed(() => targetKindOf(props.kind) === 'either');
const dialog = computed(() => props.bulk.dialog);
const chosen = computed(() => (dialog.value?.choice ? dialog.value.choiceLabel ?? String(dialog.value.choice.value) : ''));
const chosenIsTeam = computed(() => dialog.value?.choice?.target === 'team');
const picker = ref<{ focus: () => void } | null>(null);
const change = ref<HTMLButtonElement | null>(null);
const placeholder = computed(() => (teams.value ? 'Search people and teams by name…' : 'Search people by name…'));

async function onPick(hit: PersonHit | TeamHit): Promise<void> {
	if (isTeamHit(hit)) props.bulk.choose(hit.team_id, hitName(hit), 'team');
	else props.bulk.choose(hit.person_id, hitName(hit), 'person');
	// the search box goes away with the pick: focus moves to Change, so the keyboard is not left on nothing
	await nextTick();
	change.value?.focus();
}
async function onChange(): Promise<void> {
	props.bulk.clearChoice();
	await nextTick();
	picker.value?.focus();
}
function onRole(e: Event): void {
	props.bulk.chooseRole((e.target as HTMLSelectElement).value as AccessRole);
}
</script>

<template>
	<div class="target">
		<div v-if="chosen" class="chip">
			<span class="who">
				<strong>{{ chosen }}</strong>
				<span class="kind">{{ chosenIsTeam ? 'Team' : 'Person' }}</span>
			</span>
			<button ref="change" type="button" class="link" :disabled="bulk.applying" @click="onChange">Change</button>
		</div>
		<div v-else class="pick">
			<span class="lbl">{{ teams ? 'Person or team' : 'Person' }}</span>
			<AccessPersonPicker
				ref="picker" :list="null" :entries="false" :teams="teams" :disabled="bulk.applying"
				:label="teams ? 'Search people and teams' : 'Search people'" :placeholder="placeholder" @pick="onPick"
			/>
		</div>
		<label v-if="takesRole(kind)" class="fld">
			<span>Access level</span>
			<select :value="dialog?.role" :disabled="bulk.applying" @change="onRole">
				<option v-for="r in roleChoices(def)" :key="r.value" :value="r.value">{{ r.label }}</option>
			</select>
		</label>
	</div>
</template>

<style scoped>
.target { display: flex; flex-direction: column; gap: 12px; }
.pick { display: flex; flex-direction: column; gap: 4px; }
.lbl, .fld > span { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.chip { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); }
.who { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-md, 13px); }
.who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.fld { display: flex; flex-direction: column; gap: 4px; }
.fld select {
	height: 34px; padding: 0 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-md, 13px);
}
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}
.link:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
