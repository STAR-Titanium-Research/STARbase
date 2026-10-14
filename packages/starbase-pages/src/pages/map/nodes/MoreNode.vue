<script setup lang="ts">
import { computed } from 'vue';
import type { MoreNode } from '../model/types';
import { stopping, useMapActions } from './actions';

// The stub that ends a used-in fan (spec D20): "+N more", a click loads the next page of the fan. It is
// not a record: it has no sockets, is not selectable and does not open the rail.
const props = defineProps<{ id: string; data: MoreNode }>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();
const label = computed(() => `+${props.data.remaining} more`);
const load = stopping(() => actions.expand(props.id));
</script>

<template>
	<div class="node more nodrag nopan" role="button" tabindex="0" :aria-label="`Load ${label}`" @click="load" @keydown.enter="load" @keydown.space.prevent="load">
		<v-icon name="add" x-small />
		<span>{{ label }}</span>
	</div>
</template>

<style scoped>
.more { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 12px; border-style: dashed; font-weight: 600; color: var(--d1-dim); }
.more:hover { color: var(--theme--foreground); }
.more:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
