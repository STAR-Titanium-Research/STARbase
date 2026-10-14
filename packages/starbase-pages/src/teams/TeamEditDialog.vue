<script setup lang="ts">
// Create a team (name, description, colour) or edit one (the same, plus its logo). The caller of a new team becomes its manager. The logo is
// uploaded to Directus (png, jpeg or svg, 1 MB at most; checked here first) when the team is saved, and the team's `logo` set to the file;
// "Remove logo" sets it to null. A new team has no logo yet: the endpoint's create takes none, so it is added by editing the team.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { DEFAULT_TEAM_COLOR, TEAM_COLORS, TeamTile, createTeam, lightDark, updateTeam, uploadTeamLogo, useExplorerHost } from '@d1/ui';
import type { TeamColor, TeamEdit, TeamSummary } from '@d1/ui';
import { LOGO_TYPES, logoProblem, tileOf } from './teamPage';

const props = defineProps<{ modelValue: boolean; team: TeamSummary | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'saved', team: TeamSummary): void }>();

const host = useExplorerHost();
const isNew = computed(() => !props.team);

const name = ref('');
const description = ref('');
const color = ref<TeamColor>(DEFAULT_TEAM_COLOR);
// The logo the form will save: the team's own (untouched), a chosen file (not yet uploaded), or none (removed).
const file = ref<File | null>(null);
const preview = ref<string | null>(null);
const removed = ref(false);
const saving = ref(false);
const err = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const close = () => emit('update:modelValue', false);
const dropPreview = () => {
	if (preview.value) URL.revokeObjectURL(preview.value);
	preview.value = null;
};
onBeforeUnmount(dropPreview);

watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		name.value = props.team?.name ?? '';
		description.value = props.team?.description ?? '';
		color.value = props.team?.color ?? DEFAULT_TEAM_COLOR;
		file.value = null;
		removed.value = false;
		err.value = '';
		dropPreview();
	},
	{ immediate: true },
);

const hasLogo = computed(() => !!file.value || (!!props.team?.logo && !removed.value));
const tile = computed(() => ({ ...tileOf({ name: name.value || 'Team', color: color.value, logo: removed.value ? null : props.team?.logo }) }));

function chosen(e: Event) {
	const input = e.target as HTMLInputElement;
	const f = input.files?.[0];
	input.value = '';
	if (!f) return;
	const problem = logoProblem(f);
	if (problem) {
		err.value = problem;
		return;
	}
	err.value = '';
	dropPreview();
	file.value = f;
	preview.value = URL.createObjectURL(f);
	removed.value = false;
}
function removeLogo() {
	file.value = null;
	dropPreview();
	removed.value = true;
}

async function save() {
	const n = name.value.trim();
	if (!n) {
		err.value = 'Name is required.';
		return;
	}
	saving.value = true;
	err.value = '';
	try {
		const body = { name: n, description: description.value.trim(), color: color.value };
		let saved: TeamSummary;
		if (!props.team) {
			saved = await createTeam(host.api, body);
		} else {
			const patch: TeamEdit = { ...body, description: body.description || null };
			if (file.value) patch.logo = await uploadTeamLogo(host.api, file.value);
			else if (removed.value) patch.logo = null;
			saved = await updateTeam(host.api, props.team.team_id, patch);
		}
		close();
		emit('saved', saved);
	} catch (e: any) {
		// TEAM_NAME_TAKEN, NO_PERSON, BAD_LOGO...: the endpoint's own words say what to do.
		err.value = e?.message || 'Could not save the team.';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="edit-card">
			<v-card-title>{{ isNew ? 'New team' : 'Edit team' }}</v-card-title>
			<v-card-text>
				<div class="fld"><label>Name *</label><v-input v-model="name" placeholder="e.g. Additive" autofocus /></div>
				<div class="fld"><label>Description</label><v-textarea v-model="description" placeholder="Optional" /></div>
				<div class="fld">
					<span class="lbl" id="team-colour">Colour</span>
					<div class="swatches" role="radiogroup" aria-labelledby="team-colour">
						<button
							v-for="c in TEAM_COLORS"
							:key="c"
							type="button"
							role="radio"
							class="sw"
							:class="{ on: color === c }"
							:aria-checked="color === c"
							:aria-label="c"
							:title="c"
							:style="{ background: lightDark(c, 'bg') }"
							@click="color = c"
						/>
					</div>
				</div>
				<div v-if="!isNew" class="fld">
					<span class="lbl">Logo</span>
					<div class="logo">
						<img v-if="preview" class="preview" :src="preview" alt="" />
						<TeamTile v-else :team="tile" size="lg" />
						<div class="logo-actions">
							<input ref="fileInput" class="file" type="file" :accept="LOGO_TYPES.join(',')" aria-label="Choose a logo" @change="chosen" />
							<v-button small secondary @click="fileInput?.click()">{{ hasLogo ? 'Change logo' : 'Upload logo' }}</v-button>
							<v-button v-if="hasLogo" small secondary @click="removeLogo">Remove logo</v-button>
						</div>
					</div>
					<span class="hint">PNG, JPEG or SVG, 1 MB at most. Without one the team shows its initials on its colour.</span>
				</div>
				<p v-else class="hint">You become the team's manager. A logo can be added once the team exists.</p>
				<p v-if="err" class="err" role="alert">{{ err }}</p>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary @click="close">Cancel</v-button>
				<v-button :loading="saving" @click="save">{{ isNew ? 'Create team' : 'Save' }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.edit-card { width: min(520px, calc(100vw - 24px)); }
.fld { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.fld label, .lbl { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.spacer { flex: 1; }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.sw { width: 28px; height: 28px; border-radius: 8px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.sw.on { outline: 2px solid var(--theme--foreground); outline-offset: 2px; }
.sw:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.logo { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.preview { width: 48px; height: 48px; object-fit: cover; border-radius: 22%; border: 1px solid var(--d1-line); }
.logo-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.file { display: none; }
</style>
