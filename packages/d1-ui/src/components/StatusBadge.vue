<script setup lang="ts">
import { computed } from 'vue';
import { statusStyle, type StatusKind } from '../status';

// A status as a coloured pill. Renders nothing for a missing value.
const props = defineProps<{ kind: StatusKind; value: string | null | undefined }>();
const style = computed(() => statusStyle(props.kind, props.value));
</script>

<template>
	<span v-if="style" class="d1-badge" :class="`tone--${style.tone}`">{{ style.label }}</span>
</template>

<style scoped>
.d1-badge {
	display: inline-block;
	padding: 1px 9px;
	border-radius: 99px;
	font-size: 11.5px;
	font-weight: 650;
	line-height: 1.6;
	white-space: nowrap;
	color: var(--d1-tone-fg);
	background: var(--d1-tone-bg);
}
.tone--neutral { --d1-tone-fg: var(--theme--foreground-subdued); --d1-tone-bg: var(--theme--background-normal); }
.tone--info { --d1-tone-fg: var(--theme--primary); --d1-tone-bg: var(--theme--primary-background); }
.tone--progress, .tone--warning { --d1-tone-fg: var(--theme--warning); --d1-tone-bg: var(--theme--warning-background); }
.tone--success { --d1-tone-fg: var(--theme--success); --d1-tone-bg: var(--theme--success-background); }
.tone--danger { --d1-tone-fg: var(--theme--danger); --d1-tone-bg: var(--theme--danger-background); }
</style>
