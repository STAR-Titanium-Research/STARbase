<script setup lang="ts">
import { watchEffect } from 'vue';
import { usePagePin } from '@d1/ui';
import TitlePin from './TitlePin.vue';

// STARbase's page frame (setPageFrame) and, from Task 8, its <private-view> for the plotters: the page's
// title row (with its headline crumbs, the title-outer:prepend slot People uses for its back button, and
// the actions) in a header that sticks to the top of the content column, then the page. Its root sets
// --d1-header-offset, which the record pages' sticky rail reads (they fall back to Data Studio's 70px).
// A page that can be pinned provides its target (providePagePin); the pin button then shows right after the
// title while the pointer is over the title or the button has focus (DESIGN.md "Pin on the title").
const props = defineProps<{ title?: string }>();
const pin = usePagePin();
watchEffect(() => {
	if (typeof document !== 'undefined') document.title = props.title ? `${props.title} · STARbase` : 'STARbase';
});
</script>

<template>
	<div class="sb-frame">
		<header class="sb-frame-head">
			<slot name="title-outer:prepend" />
			<div class="sb-title-wrap">
				<h1 class="sb-title">{{ title }}</h1>
				<TitlePin v-if="pin" :target="pin" />
			</div>
			<div v-if="$slots.headline" class="sb-headline"><slot name="headline" /></div>
			<div class="sb-actions"><slot name="actions" /></div>
		</header>
		<div class="sb-frame-body"><slot /></div>
	</div>
</template>

<style scoped>
/* One row: [back button] Title  | Home ............ actions. The breadcrumb sits to the right of the title, not on a line of its own. */
.sb-frame { --d1-header-offset: 52px; min-height: 100%; }
.sb-frame-head {
	position: sticky; top: 0; z-index: 5; box-sizing: border-box; height: 44px; padding: 0 var(--content-padding, 32px);
	display: flex; align-items: center; gap: 8px; min-width: 0;
	background: var(--theme--background); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-headline { display: flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; padding-left: 12px; margin-left: 4px; border-left: 1px solid var(--theme--border-color-subdued); font-size: var(--fs-sm, 12px); color: var(--theme--foreground-subdued); }
.sb-headline :deep(a), .sb-headline :deep(.crumb) { color: inherit; font-weight: 500; text-decoration: none; cursor: pointer; }
.sb-headline :deep(a:hover), .sb-headline :deep(.crumb:hover) { color: var(--theme--foreground); text-decoration: underline; }
.sb-title-wrap { display: flex; align-items: center; gap: 2px; flex: 0 1 auto; min-width: 0; }
.sb-title-wrap:hover :deep(.sb-pin), .sb-title-wrap:focus-within :deep(.sb-pin) { opacity: 1; }
.sb-title { margin: 0; flex: 0 1 auto; min-width: 0; font-size: var(--fs-xl, 18px); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
@media (max-width: 767px) {
	.sb-frame-head { position: static; height: auto; min-height: 44px; padding-top: 6px; padding-bottom: 6px; flex-wrap: wrap; }
	.sb-title { white-space: normal; }
}
</style>
