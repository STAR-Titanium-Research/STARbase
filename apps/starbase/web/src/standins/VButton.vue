<script setup lang="ts">
import { computed } from 'vue';
import { AppLink } from '@d1/ui';

// Stand-in for Directus's <v-button>. `to` is a path in the Directus form ('/home/…', '/content/…'), so
// it goes through AppLink (links.ts): a STARbase route stays in the app, anything else opens d1-server in
// a new tab. Without `to` it is a plain button; the page's @click falls through to it.
const props = defineProps<{
	to?: string; secondary?: boolean; kind?: 'normal' | 'warning' | 'danger';
	small?: boolean; xSmall?: boolean; large?: boolean; icon?: boolean; rounded?: boolean; loading?: boolean; disabled?: boolean;
}>();
const classes = computed(() => ({
	secondary: props.secondary, danger: props.kind === 'danger', warning: props.kind === 'warning',
	small: props.small, 'x-small': props.xSmall, large: props.large, icon: props.icon, rounded: props.rounded,
}));
</script>

<template>
	<AppLink v-if="to && !disabled" :to="to" class="v-button" :class="classes"><slot /></AppLink>
	<button v-else type="button" class="v-button" :class="classes" :disabled="disabled || loading" :aria-busy="loading ? 'true' : undefined">
		<span v-if="loading" class="spinner" aria-hidden="true" />
		<slot />
	</button>
</template>

<style scoped>
.v-button {
	display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 36px; padding: 0 14px;
	border: 1px solid var(--theme--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--primary); color: var(--theme--primary-foreground);
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; text-decoration: none; white-space: nowrap; cursor: pointer;
}
.v-button.secondary { background: var(--theme--background-normal); color: var(--theme--foreground); }
.v-button.danger { background: var(--theme--danger); border-color: var(--theme--danger); color: #fff; }
.v-button.warning { background: var(--theme--warning); border-color: var(--theme--warning); color: #111; }
.v-button.small { min-height: 30px; padding: 0 10px; font-size: var(--fs-sm, 12px); }
.v-button.x-small { min-height: 24px; padding: 0 8px; font-size: var(--fs-xs, 11px); }
.v-button.large { min-height: 44px; padding: 0 18px; }
.v-button.icon { width: 36px; padding: 0; }
.v-button.rounded { border-radius: 999px; }
.v-button:disabled { opacity: 0.5; cursor: default; }
.v-button:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 2px; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent; animation: spin 0.9s linear infinite; }
</style>
