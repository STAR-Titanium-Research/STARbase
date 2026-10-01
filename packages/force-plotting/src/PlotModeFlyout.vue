<script setup lang="ts">
// Plot-mode picker that is also the panel's title: shows only the ACTIVE mode, as header text in the
// host's own font, until pointed at, then slides the other modes out beside it. It lives in the
// title bar because a header reading "FFT" above a toolbar pill reading "FFT" said it twice. The
// Record page's plot panels, their pop-out window and the Plot dashboard's Signals panel all use
// it, so a plot's mode is picked the same way everywhere. Hosts give its parent the bar's free
// width (flex: 1) to slide into; without room it drops down as a menu instead.
//
// Every option is always in the DOM (just clipped) rather than rendered on open, for two reasons:
// the slide can animate from a real measured width, and `listEl.scrollWidth` reports the full
// natural width even while collapsed -- which is how the horizontal-vs-vertical decision below is
// made without a hidden measuring pass.
import { computed, ref } from 'vue';

const props = defineProps<{
	modes: { key: string; label: string; title?: string }[];
	modelValue: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const vertical = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const active = computed(() => props.modes.find((m) => m.key === props.modelValue) ?? props.modes[0]);
const others = computed(() => props.modes.filter((m) => m.key !== active.value?.key));

// Decided per-open, not once on mount: these bars wrap and reflow (the panel is resizable and the
// grid is user-arranged), so the space beside this control is not a fixed property of it.
// The horizontal list only ever opens to the RIGHT, inside the host element, so the room that
// matters is between this control and the host's (or viewport's) right edge -- less whatever
// follows it in the host (a LIVE badge, a status word), which the slide pushes along.
function reflow() {
	const root = rootEl.value, list = listEl.value;
	if (!root || !list) return;
	const r = root.getBoundingClientRect();
	const host = root.parentElement;
	const edge = Math.min(window.innerWidth, host?.getBoundingClientRect().right ?? window.innerWidth);
	const gap = host ? parseFloat(getComputedStyle(host).columnGap) || 0 : 0;
	let trailing = 0;
	for (let el = root.nextElementSibling; el; el = el.nextElementSibling) trailing += el.getBoundingClientRect().width + gap;
	const needed = list.scrollWidth + 8;
	vertical.value = needed > edge - r.right - trailing - 4;
}
function show() { if (!open.value) reflow(); open.value = true; }
function hide() { open.value = false; }
function pick(key: string) {
	emit('update:modelValue', key);
	open.value = false;
}
// Hover-to-open is for mice only: touch fires emulated enter/leave around every tap.
function onEnter(ev: PointerEvent) { if (ev.pointerType === 'mouse') show(); }
function onLeave(ev: PointerEvent) { if (ev.pointerType === 'mouse') hide(); }
// Open on keyboard focus only: a tap also focuses the button, and opening there would let the
// click that follows close it again straight away.
function onFocusIn(ev: FocusEvent) { if ((ev.target as Element).matches(':focus-visible')) show(); }
</script>

<template>
	<div ref="rootEl" class="pmf" :class="{ open, vertical }"
		@pointerenter="onEnter" @pointerleave="onLeave" @focusin="onFocusIn" @focusout="hide">
		<!-- data-mode is the stable hook for "select mode X": the visible label differs between
			 hosts ("Force" vs "Time") and the active button carries a caret, so matching on text is
			 unreliable. -->
		<button type="button" class="pmf-btn pmf-active" :data-mode="active?.key"
			:title="active?.title || active?.label" @click="open ? hide() : show()">
			{{ active?.label }}
			<span class="pmf-caret" aria-hidden="true">›</span>
		</button>
		<div ref="listEl" class="pmf-list">
			<button v-for="m in others" :key="m.key" type="button" class="pmf-btn" :data-mode="m.key"
				:title="m.title || m.label" :tabindex="open ? 0 : -1" @click="pick(m.key)">{{ m.label }}</button>
		</div>
	</div>
</template>

<style scoped>
.pmf {
	/* App tokens, falling back to the Directus theme when this renders inside the admin. */
	--fp-bg-2: var(--bg-2, var(--theme--background, #fff));
	--fp-border: var(--border, var(--theme--border-color-subdued, #e7ebf0));
	--fp-surface: var(--surface, var(--theme--background-subdued, #f7f9fb));
	--fp-surface-2: var(--surface-2, var(--theme--background-normal, #f0f4f9));
	--fp-text: var(--text, var(--theme--foreground, #1e293b));
	--fp-text-dim: var(--text-dim, var(--theme--foreground-subdued, #6b7684));
	position: relative; display: inline-flex; align-items: center;
}
/* The options are small pills, a header row tall (no taller than a 20px icon). */
.pmf-btn {
	padding: 1px 8px; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 400; letter-spacing: normal;
	line-height: 1.2; white-space: nowrap;
	color: var(--fp-text-dim); background: var(--fp-surface);
	border: 1px solid var(--fp-border); border-radius: 7px; cursor: pointer;
}
.pmf-btn:hover { color: var(--fp-text); background: var(--fp-surface-2); }
/* The active mode is the title: the host's font (each bar sizes its own title), no fill, and
   shifted left by its padding so its text lines up with the other panels' titles. */
.pmf-active {
	display: inline-flex; align-items: center; gap: 5px; margin-left: -6px; padding: 1px 6px;
	font-size: inherit; font-weight: inherit; letter-spacing: inherit;
	color: inherit; background: transparent; border-color: transparent;
}
.pmf-active:hover, .pmf.open .pmf-active { color: inherit; background: var(--fp-surface-2); }
.pmf-caret { font-size: var(--fs-md, 13px); line-height: 1; color: var(--fp-text-dim); transition: transform 0.24s ease; }
.pmf.open .pmf-caret { transform: rotate(90deg); }

/* Horizontal (default): max-width carries the slide, so it animates without hardcoding a width. */
.pmf-list {
	display: flex; gap: 4px; overflow: hidden;
	max-width: 0; opacity: 0; margin-left: 0;
	transition: max-width 0.28s ease, opacity 0.18s ease, margin-left 0.28s ease;
}
.pmf.open .pmf-list { max-width: 620px; opacity: 1; margin-left: 4px; }

/* Vertical fallback when the row can't fit the full list beside the active button. */
.pmf.vertical .pmf-list {
	position: absolute; top: calc(100% + 4px); left: 0; z-index: 40;
	flex-direction: column; max-width: none; margin-left: 0;
	max-height: 0; padding: 0;
	background: var(--fp-bg-2); border: 1px solid transparent; border-radius: 9px;
	transition: max-height 0.28s ease, opacity 0.18s ease, padding 0.2s ease;
}
.pmf.vertical.open .pmf-list {
	max-height: 320px; padding: 4px; border-color: var(--fp-border);
	box-shadow: 0 12px 34px rgba(0, 0, 0, 0.3);
}
.pmf.vertical .pmf-list .pmf-btn { text-align: left; width: 100%; padding: 4px 9px; border-color: transparent; background: transparent; }
.pmf.vertical .pmf-list .pmf-btn:hover { background: var(--fp-surface-2); }

@media (prefers-reduced-motion: reduce) {
	.pmf-list, .pmf-caret { transition: none; }
}
</style>
