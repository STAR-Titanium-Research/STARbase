<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { assetUrl, useExplorerHost, type LinkedFile } from '@d1/ui';
import SemSettingsList from '../../inbox/SemSettingsList.vue';
import { fieldOf } from '../../inbox/semSettings';
import { createSemSettings } from '../../inbox/useSemSettings';

// One linked file of a record: its name with the copy, open or download buttons, and for an SEM image its imaging settings (the owner may
// correct them, anyone else who may read the file only reads them). A file the reader may not see is a locked file and nothing else (ADR-0022):
// a lock and "A file from another person's folder", no name, no values, no link, no owner. Directus says so by answering `directus_files_id: null` in the
// junction row (kind 'locked'); the settings route says so too (`locked: true`), and then a name Directus did let through is taken off the row.
const props = defineProps<{ file: LinkedFile }>();

const host = useExplorerHost();
const { state, rows, canEdit, error, editing, draft, saving, fieldError, load, start, cancel, save, cancelPending } = createSemSettings(host.api, () => props.file.id);

// Only these formats are ever read as an SEM image (the crawler decodes TIFF, JPEG, PNG and BMP): any other file has no settings to ask for. And only
// a Directus file linked through data_files: a share path (operation_files) has no directus_files id, so the route would only ever answer locked.
const IMAGE_NAME = /\.(tiff?|png|jpe?g|bmp)$/i;
const asks = computed(() => props.file.source === 'data_files' && props.file.kind !== 'locked' && IMAGE_NAME.test(props.file.name));
const locked = computed(() => props.file.kind === 'locked' || (asks.value && state.value === 'locked'));

watch(
	() => [props.file.id, asks.value] as const,
	() => {
		if (asks.value) void load();
		else cancelPending();
	},
	{ immediate: true },
);
onBeforeUnmount(cancelPending);

const copied = ref<string | null>(null);
async function copy(text: string, key: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = document.createElement('textarea');
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		document.execCommand('copy');
		document.body.removeChild(ta);
	}
	copied.value = key;
	setTimeout(() => (copied.value = null), 1500);
}
</script>

<template>
	<li class="file" :class="{ locked }" data-test="linked-file" :data-locked="locked ? 'true' : 'false'">
		<template v-if="locked">
			<v-icon name="lock" small />
			<span class="locked-text">A file from another person's folder</span>
		</template>
		<template v-else>
			<v-icon name="insert_drive_file" small />
			<span class="name" :title="file.unc ?? file.name">{{ file.name }}</span>
			<span class="spacer" />
			<template v-if="file.kind === 'archive' && file.unc && file.folder">
				<v-icon
					v-tooltip="copied === file.id + ':file' ? 'Copied!' : 'Copy file path'"
					:name="copied === file.id + ':file' ? 'check' : 'content_copy'"
					clickable small
					@click="copy(file.unc, file.id + ':file')"
				/>
				<v-icon
					v-tooltip="copied === file.id + ':dir' ? 'Copied!' : 'Copy folder path (paste into Explorer address bar)'"
					:name="copied === file.id + ':dir' ? 'check' : 'folder_copy'"
					clickable small
					@click="copy(file.folder, file.id + ':dir')"
				/>
				<a v-if="file.fileUri" :href="file.fileUri" target="_blank" rel="noopener">
					<v-icon v-tooltip="'Open (only works with the d1file:// handler or a permissive browser)'" name="open_in_new" clickable small />
				</a>
			</template>
			<a v-else :href="assetUrl(file.id, { download: '' })" target="_blank" rel="noopener">
				<v-icon v-tooltip="'Download'" name="download" clickable small />
			</a>

			<div v-if="asks && state !== 'none'" class="sem" data-test="sem-block">
				<span v-if="state === 'loading'" class="dim" data-test="sem-loading">Reading imaging settings…</span>
				<span v-else-if="state === 'error'" class="dim" data-test="sem-error">
					Imaging settings could not be loaded<template v-if="error"> ({{ error }})</template>.
					<button type="button" class="link" @click="load()">Retry</button>
				</span>
				<SemSettingsList v-else-if="rows.length" :rows="rows">
					<template #after="{ row }">
						<template v-if="editing === row.key">
							<input
								v-model="draft"
								class="edit"
								:type="fieldOf(row.key)?.type === 'time' ? 'datetime-local' : 'text'"
								:inputmode="fieldOf(row.key)?.type === 'number' || fieldOf(row.key)?.type === 'integer' ? 'decimal' : undefined"
								:aria-label="`New value for ${row.label}`"
								:disabled="saving"
								data-test="edit-input"
								@keydown.enter.prevent="save()"
								@keydown.esc.prevent="cancel()"
							/>
							<span v-if="fieldOf(row.key)?.unit" class="unit">{{ fieldOf(row.key)?.unit }}</span>
							<button type="button" class="link" :disabled="saving" data-test="edit-save" @click="save()">Save</button>
							<button type="button" class="link" :disabled="saving" data-test="edit-cancel" @click="cancel()">Cancel</button>
						</template>
						<button v-else-if="canEdit" type="button" class="link" :aria-label="`Edit ${row.label}`" data-test="edit-setting" @click="start(row.key)">Edit</button>
						<span v-if="fieldError && fieldError.key === row.key" class="error" role="alert" data-test="setting-error">{{ fieldError.text }}</span>
					</template>
				</SemSettingsList>
			</div>
		</template>
	</li>
</template>

<style scoped>
/* A row of the Files panel: the file's name and its actions on one line, its imaging settings under them. */
.file { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 0; font-size: var(--fs-md); }
.file + .file { border-top: 1px solid var(--d1-line); }
.name { overflow-wrap: anywhere; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm); }
.spacer { flex: 1; }
.locked-text { color: var(--d1-dim); font-style: italic; }
.file.locked { color: var(--d1-dim); }
.sem { flex: 1 0 100%; padding-left: 24px; min-width: 0; }
.dim { font-size: var(--fs-sm); color: var(--d1-dim); }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-xs, 11px); color: var(--d1-accent, var(--theme--primary)); cursor: pointer; }
.link:hover:not(:disabled) { text-decoration: underline; }
.link:disabled { opacity: 0.5; cursor: default; }
.edit {
	width: 11em; max-width: 100%; padding: 1px 6px; font: inherit; font-size: var(--fs-sm); color: var(--theme--foreground);
	background: var(--theme--background); border: 1px solid var(--theme--form--field--input--border-color, var(--d1-line)); border-radius: 4px;
}
.unit { font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.error { font-size: var(--fs-xs, 11px); color: var(--d1-err, var(--theme--danger)); }
</style>
