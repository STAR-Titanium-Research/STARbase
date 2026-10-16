<script setup lang="ts">
import { Section, LoadState, type LinkedFile } from '@d1/ui';
import LinkedFileItem from './LinkedFileItem.vue';

// Linked data files, as the d1-archive-links interface shows them: files from the lab archive
// get copy-path buttons (paste into Windows Explorer), files uploaded to Directus a download link.
// An SEM image also shows its imaging settings; a file the reader may not see is a locked file (LinkedFileItem).
// The Operation and Test pages reuse it with their own empty text.
defineProps<{ files: LinkedFile[]; loading: boolean; error: string; emptyText?: string }>();
</script>

<template>
	<Section title="Files" :count="loading ? null : files.length" :empty="!loading && !error && !files.length" :empty-text="emptyText ?? 'No files linked to this sample.'">
		<LoadState :loading="loading" :error="error">
			<ul class="files">
				<LinkedFileItem v-for="f in files" :key="f.id" :file="f" />
			</ul>
			<p class="hint">Tip: copy the path, then paste it into Windows Explorer's address bar.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.files { list-style: none; margin: 0; padding: 0; }
.hint { margin: 8px 0 0; font-size: var(--fs-sm); color: var(--d1-dim); }
</style>
