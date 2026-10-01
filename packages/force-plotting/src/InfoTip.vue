<script setup lang="ts">
// A small ⓘ affordance that reveals an explanation on hover or focus.
//
// Deliberately CSS-only rather than a floating-ui popper: the workbench panels scroll and are
// drag-resizable, and a JS-positioned layer has to be re-measured on every one of those events.
// A positioned child with `position: fixed`-like escape is not needed either -- the bubble is
// clamped to the panel and allowed to scroll into view.
//
// Keyboard-reachable (tabindex + focus-within) so the explanation is not mouse-only.
withDefaults(defineProps<{
	text: string;
	/** Where the bubble opens relative to the icon. `auto` = below-right, the safe default. */
	placement?: 'auto' | 'left';
	/** Optional bolded first line, e.g. the parameter's real meaning in one phrase. */
	title?: string;
	/** Wider bubble for multi-sentence step descriptions. */
	wide?: boolean;
}>(), { placement: 'auto', title: '', wide: false });
</script>

<template>
	<span class="info-tip" :class="{ left: placement === 'left', wide }" tabindex="0" role="note" :aria-label="text">
		<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
			<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4" />
			<circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
			<path d="M8 7.1v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
		</svg>
		<span class="it-bubble">
			<strong v-if="title">{{ title }}</strong>
			<span>{{ text }}</span>
		</span>
	</span>
</template>

<style scoped>
.info-tip {
	position: relative; display: inline-flex; align-items: center; justify-content: center;
	color: var(--text-dim, #94a3b8); cursor: help; outline: none; flex: none;
	vertical-align: -1px; border-radius: 50%;
}
.info-tip:hover, .info-tip:focus-visible { color: var(--accent, #38bdf8); }
.info-tip:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #38bdf8) 50%, transparent); }
.it-bubble {
	position: absolute; z-index: 60; top: calc(100% + 6px); left: -8px;
	width: 250px; padding: 8px 10px; border-radius: 8px;
	background: var(--bg-1, #0f172a); color: var(--text, #e5e7eb);
	border: 1px solid var(--border, rgba(255,255,255,0.16));
	box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5);
	font-size: var(--fs-xs, 11px); line-height: 1.45; font-weight: 400; font-style: normal;
	text-align: left; white-space: normal; letter-spacing: normal; text-transform: none;
	opacity: 0; visibility: hidden; transform: translateY(-3px);
	transition: opacity 0.12s ease, transform 0.12s ease, visibility 0.12s;
	pointer-events: none;
}
.info-tip.wide .it-bubble { width: 310px; }
.info-tip.left .it-bubble { left: auto; right: -8px; }
.info-tip:hover .it-bubble, .info-tip:focus-visible .it-bubble {
	opacity: 1; visibility: visible; transform: translateY(0);
}
.it-bubble strong { display: block; margin-bottom: 3px; color: var(--accent, #7dd3fc); font-weight: 650; }
</style>
