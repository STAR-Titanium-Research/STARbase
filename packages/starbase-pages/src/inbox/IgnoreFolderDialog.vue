<script setup lang="ts">
import { computed } from 'vue';
import { ignoreConfirm } from './ignoredFolders';
import type { IgnoreDialog } from './useIgnoredFolders';

// The confirm of "Ignore this folder": it says what happens, in full (the crawler leaves the folder alone, the open files below it move to Dismissed and
// can be restored, linked files stay linked, nothing on the share changes). The count on screen is an estimate and says so; the real one comes back
// in the answer and goes into the notice. A refusal is shown here, in the server's words, and the dialog stays open.
const props = defineProps<{ dialog: IgnoreDialog }>();
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>();

const text = computed(() => (props.dialog.target ? ignoreConfirm(props.dialog.target, props.dialog.shown) : null));
const team = computed(() => (props.dialog.target?.ownerKind === 'team' ? props.dialog.target.ownerName : ''));
</script>

<template>
	<v-dialog :model-value="dialog.open" @update:model-value="(v: boolean) => !v && emit('cancel')" @esc="emit('cancel')">
		<v-card v-if="text" class="confirm">
			<v-card-title data-test="ignore-title">{{ text.title }}</v-card-title>
			<v-card-text>
				<p v-for="(line, i) in text.lines" :key="i" data-test="ignore-line">{{ line }}</p>
				<p v-if="team" class="hint" data-test="ignore-team">This is a team folder: the rule belongs to {{ team }}, for everyone in the team.</p>
				<p v-if="dialog.error" class="err" role="alert" data-test="ignore-error">{{ dialog.error }}</p>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary :disabled="dialog.busy" data-test="ignore-cancel" @click="emit('cancel')">Cancel</v-button>
				<v-button :loading="dialog.busy" data-test="ignore-confirm" @click="emit('confirm')">Stop scanning</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.confirm { width: min(520px, calc(100vw - 24px)); }
p { margin: 0 0 8px; line-height: 1.5; }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.spacer { flex: 1; }
</style>
