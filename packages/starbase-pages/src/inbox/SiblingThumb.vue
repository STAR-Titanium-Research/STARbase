<script setup lang="ts">
import { computed } from 'vue';
import { useExplorerHost } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { hasThumbnail, kindIcon, nameOf } from './inboxModel';
import { siblingLabel } from './linkedModel';
import { usePicture } from './usePicture';

// One small picture of the sibling strip (LinkedSiblings): the file's thumbnail, loaded with the signed-in session like a list row's, as a button that reports
// the click. A picture that is not made yet, or fails, shows the icon of its kind, never a broken image.
const props = defineProps<{ file: FoundFile; picking: boolean }>();
const emit = defineEmits<{ (e: 'pick', file: FoundFile): void }>();

const host = useExplorerHost();
const name = computed(() => nameOf(props.file.rel_path));
const withPicture = computed(() => hasThumbnail(props.file));
const { state, url } = usePicture(host.api, () => (withPicture.value ? props.file.candidate_id : null), 'thumb', () => true);
const label = computed(() => `${props.picking ? 'Compare with' : 'Open'} ${siblingLabel(props.file, name.value)}`);
</script>

<template>
	<button type="button" class="tile" :class="{ picking }" :title="name" :aria-label="label" :data-state="state" data-test="sibling" :data-sibling-id="file.candidate_id" @click="emit('pick', file)">
		<img v-if="url" :src="url" alt="" draggable="false" />
		<v-icon v-else :name="kindIcon(file.kind)" small />
	</button>
</template>

<style scoped>
.tile {
	flex: none; display: grid; place-items: center; box-sizing: border-box; width: 44px; height: 34px; padding: 0; overflow: hidden; cursor: pointer; font: inherit;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface, var(--theme--background)); color: var(--d1-dim);
}
.tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tile:hover, .tile.picking { border-color: var(--d1-accent, var(--theme--primary)); }
/* a touch target is at least 40px under 700px of page (DESIGN.md section 5) */
@container (max-width: 700px) { .tile { width: 52px; height: 40px; } }
.tile:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
