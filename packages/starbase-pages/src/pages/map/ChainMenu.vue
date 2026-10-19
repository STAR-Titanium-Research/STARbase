<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useEditRail } from './edit/railContext';
import type { ChainDir } from './model/hoverFocus';

// A card's right-click menu: which way the selected card's chain is lit on the map. Placed at the pointer
// (canvas coordinates) by the page; Escape, a click elsewhere or a scroll closes it, and so does choosing anything in it (it emits close after the choice).
const props = defineProps<{
	x: number;
	y: number;
	dir: ChainDir;
	/** Edit mode: Remove (and Dissolve, for a container) of the card the menu is for. Absent: view mode, the highlight only. */
	canRemove?: boolean;
	canDissolve?: boolean;
	/** Edit mode, a sample or a container: Insert before / after it (the add search); a done sample's "before" is "Add an earlier step". */
	canInsert?: boolean;
	earlier?: boolean;
}>();
const emit = defineEmits<{ pick: [dir: ChainDir]; close: []; remove: []; dissolve: []; insert: [where: 'before' | 'after'] }>();
// Edit mode, an operation or a test: Save as template… (R7). It reads and acts through the rail's context (the page provides it), so the page binds nothing for it.
const rail = useEditRail();
const canTemplate = computed(() => !!props.canRemove && !!rail?.saveTemplate?.can.value);

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
			@click="emit('pick', o.dir), emit('close')"
		>
			<v-icon :name="o.icon" x-small />
			<span>{{ o.label }}</span>
			<v-icon v-if="o.dir === props.dir" class="ck" name="check" x-small />
		</button>
		<template v-if="canRemove || canDissolve || canInsert || canTemplate">
			<div class="hd">Edit</div>
			<template v-if="canInsert">
				<button type="button" role="menuitem" class="it" @click="emit('insert', 'before'), emit('close')">
					<v-icon name="keyboard_double_arrow_left" x-small />
					<span>{{ earlier ? 'Add an earlier step…' : 'Insert before…' }}</span>
					<kbd>Shift+I</kbd>
				</button>
				<button type="button" role="menuitem" class="it" @click="emit('insert', 'after'), emit('close')">
					<v-icon name="keyboard_double_arrow_right" x-small />
					<span>Insert after…</span>
					<kbd>I</kbd>
				</button>
			</template>
			<button v-if="canTemplate" type="button" role="menuitem" class="it" @click="rail?.saveTemplate?.open(), emit('close')">
				<v-icon name="bookmark_add" x-small />
				<span>Save as template…</span>
			</button>
			<button v-if="canRemove" type="button" role="menuitem" class="it" @click="emit('remove'), emit('close')">
				<v-icon name="delete" x-small />
				<span>Remove</span>
				<kbd>Delete</kbd>
			</button>
			<button v-if="canDissolve" type="button" role="menuitem" class="it" @click="emit('dissolve'), emit('close')">
				<v-icon name="call_merge" x-small />
				<span>Dissolve</span>
				<kbd>Ctrl/⌘+Delete</kbd>
			</button>
		</template>
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
kbd { margin-left: auto; padding: 0 5px; border: 1px solid var(--d1-line); border-radius: 4px; font: inherit; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
