<script setup lang="ts">
// The record pages' action row, once for all five: compact icon-only buttons (Edit, Who has access,
// optional page-specific extras, Data Studio) in the rail. Each button keeps its old label as `title`
// and `aria-label`, and adds a visually hidden text label inside its slot (`<span class="sr-only">`).
// Under real Directus, `v-button` wraps an inner <button>, so the aria-label may not reach it; the
// in-slot text is the accessible name on both hosts. Extras go in the default slot as
// `<v-button icon small secondary title="…" aria-label="…"><v-icon …/><span class="sr-only">…</span></v-button>`
// and sit before Data Studio. Edit shows only when the viewer can change the record (`canUpdate !== false`, as before).
defineProps<{ canUpdate?: boolean | null; studioTo: string }>();
defineEmits<{ edit: []; access: [] }>();
</script>

<template>
	<v-button v-if="canUpdate !== false" icon small title="Edit" aria-label="Edit" @click="$emit('edit')"><v-icon name="edit" small /><span class="sr-only">Edit</span></v-button>
	<v-button icon small secondary title="Who has access" aria-label="Who has access" @click="$emit('access')"><v-icon name="group" small /><span class="sr-only">Who has access</span></v-button>
	<slot />
	<v-button icon small secondary :to="studioTo" title="Data Studio" aria-label="Data Studio"><v-icon name="open_in_new" small /><span class="sr-only">Data Studio</span></v-button>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
</style>
