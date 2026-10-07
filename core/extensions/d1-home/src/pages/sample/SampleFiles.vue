<script setup lang="ts">
import { ref } from 'vue';
import { Section, LoadState, type LinkedFile } from '@d1/ui';

// Linked data files, as the d1-archive-links interface shows them: files from the lab archive
// get copy-path buttons (paste into Windows Explorer), files uploaded to Directus a download link.
// The Operation and Test pages reuse it with their own empty text.
defineProps<{ files: LinkedFile[]; loading: boolean; error: string; emptyText?: string }>();

const copiedKey = ref<string | null>(null);

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
	copiedKey.value = key;
	setTimeout(() => (copiedKey.value = null), 1500);
}
</script>

<template>
	<Section title="Files" :count="loading ? null : files.length" :empty="!loading && !error && !files.length" :empty-text="emptyText ?? 'No files linked to this sample.'">
		<LoadState :loading="loading" :error="error">
			<ul class="files">
				<li v-for="f in files" :key="f.id" class="file">
					<v-icon name="insert_drive_file" small />
					<span class="name" :title="f.unc ?? f.name">{{ f.name }}</span>
					<span class="spacer" />
					<template v-if="f.kind === 'archive' && f.unc && f.folder">
						<v-icon
							v-tooltip="copiedKey === f.id + ':file' ? 'Copied!' : 'Copy file path'"
							:name="copiedKey === f.id + ':file' ? 'check' : 'content_copy'"
							clickable small
							@click="copy(f.unc, f.id + ':file')"
						/>
						<v-icon
							v-tooltip="copiedKey === f.id + ':dir' ? 'Copied!' : 'Copy folder path (paste into Explorer address bar)'"
							:name="copiedKey === f.id + ':dir' ? 'check' : 'folder_copy'"
							clickable small
							@click="copy(f.folder, f.id + ':dir')"
						/>
						<a v-if="f.fileUri" :href="f.fileUri" target="_blank" rel="noopener">
							<v-icon v-tooltip="'Open (only works with the d1file:// handler or a permissive browser)'" name="open_in_new" clickable small />
						</a>
					</template>
					<a v-else :href="`/assets/${f.id}?download`" target="_blank" rel="noopener">
						<v-icon v-tooltip="'Download'" name="download" clickable small />
					</a>
				</li>
			</ul>
			<p class="hint">Tip: copy the path, then paste it into Windows Explorer's address bar.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.files { list-style: none; margin: 0; padding: 0; border: 1px solid var(--theme--border-color-subdued); border-radius: 10px; }
.file { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 13.5px; }
.file + .file { border-top: 1px solid var(--theme--border-color-subdued); }
.name { overflow-wrap: anywhere; }
.spacer { flex: 1; }
.hint { margin: 8px 0 0; font-size: 12px; color: var(--theme--foreground-subdued); }
</style>
