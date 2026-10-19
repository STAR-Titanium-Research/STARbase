<script setup lang="ts">
import { computed, ref } from 'vue';
import { SCOPES, type TemplateInfo, type TemplateScope } from './templates';

// What a person may do with a template they made (redesign R7), inline under its entry in the palette: rename it, change who can use it,
// replace its settings with those of the selected card, or delete it. Deleting and replacing ask once more: neither can be taken back, and
// what was made from the template is never touched. Presentational: the page changes the template (d1-build refuses anyone else).
const props = defineProps<{
	info: TemplateInfo;
	/** The kind of the selected container on the canvas, if any: Replace takes its settings. */
	selectedKind: 'operation' | 'test' | null;
	selectedTitle: string;
	busy: boolean;
}>();
const emit = defineEmits<{ rename: [name: string]; scope: [scope: TemplateScope]; replace: []; delete: []; close: [] }>();

const name = ref(props.info.name);
const confirm = ref<'replace' | 'delete' | null>(null);
const trimmed = computed(() => name.value.trim());
const kindOk = computed(() => !!props.selectedKind && (props.selectedKind === 'operation') === (props.info.collection === 'manufacturing_operations'));
const replaceWhy = computed(() => {
	if (!props.selectedKind) return `Select the ${props.info.collection === 'manufacturing_operations' ? 'operation' : 'test'} to take the settings from.`;
	return kindOk.value ? '' : `Select ${props.info.collection === 'manufacturing_operations' ? 'an operation' : 'a test'}: this template is for ${props.info.collection === 'manufacturing_operations' ? 'operations' : 'tests'}.`;
});
const renameOk = computed(() => !!trimmed.value && trimmed.value !== props.info.name && trimmed.value.length <= 120 && !props.busy);
function renameNow() {
	if (renameOk.value) emit('rename', trimmed.value);
}
</script>

<template>
	<div class="pm-tm" role="group" :aria-label="`Manage the template ${info.name}`" @keydown.esc.stop="emit('close')">
		<form class="rn" @submit.prevent="renameNow">
			<input v-model="name" type="text" maxlength="140" autocomplete="off" spellcheck="false" aria-label="Template name" />
			<button type="button" class="btn" :disabled="!renameOk" @click="renameNow">Rename</button>
		</form>
		<fieldset class="scope">
			<legend>Who can use it</legend>
			<label v-for="s in SCOPES" :key="s.value" class="opt">
				<input type="radio" :name="`pm-tm-scope-${info.id}`" :value="s.value" :checked="info.scope === s.value" :disabled="busy" @change="s.value !== info.scope && emit('scope', s.value)" />
				<span>{{ s.label }}</span>
			</label>
		</fieldset>
		<div v-if="confirm === null" class="acts">
			<button type="button" class="btn" :disabled="!kindOk || busy" :title="replaceWhy" @click="confirm = 'replace'">Replace with the selected card's settings</button>
			<button type="button" class="btn" :disabled="busy" @click="confirm = 'delete'">Delete</button>
			<p v-if="replaceWhy" class="why">{{ replaceWhy }}</p>
		</div>
		<div v-else class="acts ask" role="alert">
			<p v-if="confirm === 'replace'">Replace the settings of <strong>{{ info.name }}</strong> with those of {{ selectedTitle || 'the selected card' }}? What was made from it is not changed.</p>
			<p v-else>Delete <strong>{{ info.name }}</strong>? What was made from it is not changed.</p>
			<div class="btns">
				<button type="button" class="btn" @click="confirm = null">Cancel</button>
				<button type="button" class="btn primary" :disabled="busy" @click="(confirm === 'replace' ? emit('replace') : emit('delete')), (confirm = null)">{{ confirm === 'replace' ? 'Replace' : 'Delete' }}</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pm-tm { display: flex; flex-direction: column; gap: 8px; flex-basis: 100%; margin: 2px 0 6px; padding: 8px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); font-size: var(--fs-sm, 12px); }
.rn { display: flex; gap: 6px; }
.rn input {
	flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--d1-line); border-radius: 6px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
.rn input:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
.scope { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; border: 0; }
.scope legend { padding: 0 0 2px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.opt { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.acts { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
/* Plain buttons: the replace label is long and wraps inside the dock, which a fixed-height v-button would clip. */
.btn {
	padding: 5px 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface, var(--theme--background)); color: inherit;
	font: inherit; line-height: 1.3; text-align: left; cursor: pointer;
}
.btn:hover:not(:disabled), .btn:focus-visible { background: var(--d1-tint); outline: none; }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: transparent; color: var(--d1-on-accent, var(--theme--primary-foreground, #fff)); text-align: center; }
.rn .btn { flex: none; }
.ask p, .why { margin: 0; line-height: 1.35; }
.why { color: var(--d1-dim); font-size: var(--fs-xs, 11px); }
.btns { display: flex; gap: 6px; }
.btns .btn { flex: 1; text-align: center; }
</style>
