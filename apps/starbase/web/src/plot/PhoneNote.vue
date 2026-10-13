<script setup lang="ts">
import { useNarrow } from '../narrow';

// Spec §3.3: on a phone the plotters still open, with a note.
const narrow = useNarrow();
</script>

<template>
	<p v-if="narrow" class="sb-phone-note" role="note">The plotter works best on a larger screen.</p>
</template>

<style scoped>
.sb-phone-note { margin: 0; padding: 8px 16px; font-size: var(--fs-sm, 12px); background: var(--theme--background-normal); color: var(--theme--foreground-subdued); }
</style>
