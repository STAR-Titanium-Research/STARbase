<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ type?: 'info' | 'success' | 'warning' | 'danger' }>(), { type: 'info' });
const role = computed(() => (props.type === 'danger' || props.type === 'warning' ? 'alert' : 'status'));
</script>

<template>
	<div class="v-notice" :class="type" :role="role"><slot /></div>
</template>

<style scoped>
.v-notice { padding: 10px 12px; border-radius: var(--theme--border-radius, 8px); border-left: 4px solid var(--theme--primary); background: var(--theme--background-normal); color: var(--theme--foreground); }
.v-notice.success { border-left-color: var(--theme--success); }
.v-notice.warning { border-left-color: var(--theme--warning); }
.v-notice.danger { border-left-color: var(--theme--danger); background: var(--theme--danger-background); }
</style>
