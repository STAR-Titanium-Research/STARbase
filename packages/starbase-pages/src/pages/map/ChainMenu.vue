<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ChainDir } from './model/hoverFocus';

// A card's right-click menu: which way the selected card's chain is lit on the map. Placed at the pointer
// (canvas coordinates) by the page; Escape, a click elsewhere or a scroll closes it.
const props = defineProps<{ x: number; y: number; dir: ChainDir }>();
const emit = defineEmits<{ pick: [dir: ChainDir]; close: [] }>();

const OPTIONS: { dir: ChainDir; label: string; icon: string }[] = [
	{ dir: 'up', label: 'Show upstream', icon: 'arrow_back' },
	{ dir: 'down', label: 'Show downstream', icon: 'arrow_forward' },
	{ dir: 'both', label: 'Show both', icon: 'sync_alt' },
];

const el = ref<HTMLElement | null>(null);
const onDown = (e: Event) => {
	if (el.value && !el.value.contains(e.target as Node)) emit('close');
};
const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape') emit('close');
};
const onScroll = () => emit('close');
onMounted(() => {
	document.addEventListener('pointerdown', onDown, true);
	document.addEventListener('keydown', onKey);
	document.addEventListener('wheel', onScroll, { passive: true, capture: true });
	void nextTick(() => el.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
});
onBeforeUnmount(() => {
	document.removeEventListener('pointerdown', onDown, true);
	document.removeEventListener('keydown', onKey);
	document.removeEventListener('wheel', onScroll, true);
});
</script>

<template>
	<div ref="el" class="chain-menu" role="menu" aria-label="Highlight" :style="{ left: `${props.x}px`, top: `${props.y}px` }" @contextmenu.prevent>
		<div class="hd">Highlight chain</div>
		<button
			v-for="o in OPTIONS"
			:key="o.dir"
			type="button"
			role="menuitemradio"
			:aria-checked="o.dir === props.dir"
			class="it"
			@click="emit('pick', o.dir)"
		>
			<v-icon :name="o.icon" x-small />
			<span>{{ o.label }}</span>
			<v-icon v-if="o.dir === props.dir" class="ck" name="check" x-small />
		</button>
	</div>
</template>

<style scoped>
.chain-menu {
	position: absolute;
	z-index: 30;
	min-width: 190px;
	padding: 4px;
	border-radius: 10px;
	background: var(--d1-surface);
	border: 1px solid var(--d1-line);
	box-shadow: var(--d1-shadow-lg, var(--d1-shadow));
	font-size: var(--fs-md, 13px);
}
.hd { padding: 6px 10px 4px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--d1-dim); }
.it { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: none; color: var(--theme--foreground); font: inherit; text-align: left; cursor: pointer; }
.it:hover, .it:focus-visible { background: var(--d1-tint); outline: none; }
.it[aria-checked='true'] { font-weight: 600; }
.ck { margin-left: auto; color: var(--d1-accent, var(--theme--primary)); }
</style>
