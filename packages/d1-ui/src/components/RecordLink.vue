<script setup lang="ts">
import { computed } from 'vue';
import { recordRoute } from '../recordRoute';

// A link to a record's Explorer page (or its Data Studio form when it has none).
const props = defineProps<{ collection: string; id: string | number | null | undefined }>();
const to = computed(() => (props.id === null || props.id === undefined ? null : recordRoute(props.collection, props.id)));
</script>

<template>
	<router-link v-if="to" :to="to" class="d1-record-link"><slot /></router-link>
	<span v-else><slot /></span>
</template>

<style scoped>
.d1-record-link {
	color: var(--theme--primary);
	font-weight: 600;
	text-decoration: none;
}
.d1-record-link:hover { text-decoration: underline; }
</style>
