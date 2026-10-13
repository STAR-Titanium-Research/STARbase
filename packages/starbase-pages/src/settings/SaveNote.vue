<script setup lang="ts">
import type { Saves } from './useSaves';

// "Couldn't save" with Retry, beside the control whose change did not go through (the control itself is
// already back on the stored value; usePins undoes the change). Nothing is drawn while all is well.
defineProps<{ saves: Saves; saveKey: string }>();
</script>

<template>
	<span v-if="saves.hasFailed(saveKey)" class="st-failed" role="alert">
		Couldn't save.
		<button type="button" class="st-link" @click="saves.retry(saveKey)">Retry</button>
	</span>
</template>
