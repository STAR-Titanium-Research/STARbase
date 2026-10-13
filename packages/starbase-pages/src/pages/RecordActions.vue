<script setup lang="ts">
// The record pages' action row, once for all five: compact icon-only buttons (Edit, Who has access,
// optional page-specific extras, Data Studio) in the rail. Each button keeps its old label as `title`
// and `aria-label`, so it still has a name for screen readers and a tooltip. Extras go in the default
// slot as `<v-button icon small secondary title="…" aria-label="…">` and sit before Data Studio.
// Edit shows only when the viewer can change the record (`canUpdate !== false`, as before).
defineProps<{ canUpdate?: boolean | null; studioTo: string }>();
defineEmits<{ edit: []; access: [] }>();
</script>

<template>
	<v-button v-if="canUpdate !== false" icon small title="Edit" aria-label="Edit" @click="$emit('edit')"><v-icon name="edit" small /></v-button>
	<v-button icon small secondary title="Who has access" aria-label="Who has access" @click="$emit('access')"><v-icon name="group" small /></v-button>
	<slot />
	<v-button icon small secondary :to="studioTo" title="Data Studio" aria-label="Data Studio"><v-icon name="open_in_new" small /></v-button>
</template>
