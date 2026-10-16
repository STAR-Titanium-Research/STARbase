<script setup lang="ts">
import { watchEffect } from 'vue';

// STARbase's page frame (setPageFrame) and, from Task 8, its <private-view> for the plotters: the page's
// title row (with its headline crumbs, the title-outer:prepend slot People uses for its back button, and
// the actions) in a header that sticks to the top of the content column, then the page. Its root sets
// --d1-header-offset, which the record pages' sticky rail reads (they fall back to Data Studio's 70px).
const props = defineProps<{ title?: string }>();
watchEffect(() => {
	if (typeof document !== 'undefined') document.title = props.title ? `${props.title} · STARbase` : 'STARbase';
});
</script>

<template>
	<div class="sb-frame">
		<header class="sb-frame-head">
			<div v-if="$slots.headline" class="sb-headline"><slot name="headline" /></div>
			<div class="sb-title-row">
				<slot name="title-outer:prepend" />
				<h1 class="sb-title">{{ title }}</h1>
				<div class="sb-actions"><slot name="actions" /></div>
			</div>
		</header>
		<div class="sb-frame-body"><slot /></div>
	</div>
</template>

<style scoped>
.sb-frame { --d1-header-offset: 58px; min-height: 100%; }
.sb-frame-head {
	position: sticky; top: 0; z-index: 5; box-sizing: border-box; height: 50px; padding: 4px var(--content-padding, 32px) 0;
	display: flex; flex-direction: column; justify-content: center;
	background: var(--theme--background); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-headline { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued); }
.sb-headline :deep(.crumb) { cursor: pointer; }
.sb-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sb-title { margin: 0; flex: 1 1 auto; min-width: 0; font-size: var(--fs-xl, 18px); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-actions { display: flex; align-items: center; gap: 8px; }
@media (max-width: 767px) {
	.sb-frame-head { position: static; height: auto; min-height: 56px; padding-top: 8px; padding-bottom: 8px; }
	.sb-title { font-size: var(--fs-lg, 15px); white-space: normal; }
	.sb-actions { flex-wrap: wrap; }
}
</style>
