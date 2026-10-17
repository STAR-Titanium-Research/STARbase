<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { filterConnect, type ConnectEntry } from './connectModel';
import { placeMenu } from './menuModel';

// "Connect to…" (spec E21): the sockets a socket can be wired to, named by code, searchable. The way to a wire without dragging.
// Type to narrow, ArrowUp/ArrowDown move, Enter wires, Esc closes.
const props = defineProps<{
	entries: ConnectEntry[];
	/** What it connects, for the title: "Connect S-0412-A to…". */
	from: string;
	at: { x: number; y: number };
}>();
const emit = defineEmits<{ choose: [entry: ConnectEntry]; close: [] }>();

const uid = useId();
const query = ref('');
const active = ref(0);
const shown = computed(() => filterConnect(props.entries, query.value));
/** What the list has to say instead of entries (and what the status region announces); empty while there are some. */
const message = computed(() => (!props.entries.length ? 'Nothing on the canvas can be connected to this socket.' : !shown.value.length ? 'Nothing fits what you typed.' : ''));
watch(shown, () => void (active.value = 0));
const optionId = (i: number) => `${uid}-opt-${i}`;

function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		const n = shown.value.length;
		if (n) active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
		void nextTick(() => list.value?.querySelector(`[id="${optionId(active.value)}"]`)?.scrollIntoView?.({ block: 'nearest' }));
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		const pick = shown.value[active.value];
		if (pick) emit('choose', pick);
	} else if (e.key === 'Tab') e.preventDefault();
}

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const box = ref<HTMLElement | null>(null);
const pos = ref({ left: props.at.x, top: props.at.y });
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
onMounted(async () => {
	input.value?.focus();
	await nextTick();
	const r = box.value?.getBoundingClientRect();
	if (r) pos.value = placeMenu(props.at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight });
});
onBeforeUnmount(() => {
	if (opener?.isConnected) opener.focus();
});
</script>

<template>
	<div class="pm-connect-back" @pointerdown.self="emit('close')" @contextmenu.prevent="emit('close')">
		<div ref="box" class="d1-kit d1-process-map pm-connect" role="dialog" :aria-label="`Connect ${from} to`" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" @keydown="onKey">
			<div class="ttl">Connect {{ from }} to…</div>
			<input
				ref="input"
				v-model="query"
				class="q"
				type="text"
				role="combobox"
				autocomplete="off"
				spellcheck="false"
				placeholder="Search by code…"
				aria-label="Search the sockets it can be connected to"
				aria-expanded="true"
				:aria-controls="`${uid}-list`"
				:aria-activedescendant="shown.length ? optionId(active) : undefined"
			/>
			<div :id="`${uid}-list`" ref="list" class="list" role="listbox">
				<button
					v-for="(e, i) in shown"
					:id="optionId(i)"
					:key="e.id"
					type="button"
					role="option"
					class="opt"
					:class="{ on: i === active }"
					:aria-selected="i === active"
					tabindex="-1"
					@mousemove="active = i"
					@click="emit('choose', e)"
				>
					<span class="lab">{{ e.label }}</span>
					<span class="det">{{ e.detail }}</span>
				</button>
			</div>
			<!-- One status region, always mounted: a live region that appears together with its text is often not announced. -->
			<p class="none" :class="{ empty: !message }" role="status" aria-live="polite" aria-atomic="true">{{ message }}</p>
		</div>
	</div>
</template>

<style scoped>
.pm-connect-back { position: fixed; inset: 0; z-index: 60; }
.pm-connect {
	position: fixed;
	display: flex;
	flex-direction: column;
	gap: 6px;
	width: 300px;
	max-width: calc(100vw - 16px);
	padding: 8px;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 12px;
	box-shadow: var(--d1-shadow-lg, 0 10px 30px rgb(0 0 0 / 0.22));
	font-size: var(--fs-md, 13px);
}
.ttl { padding: 0 2px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q {
	box-sizing: border-box; width: 100%; padding: 7px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
.q:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
.list { display: flex; flex-direction: column; max-height: min(320px, 50vh); overflow: auto; }
.opt { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.opt.on { background: var(--d1-tint); box-shadow: inset 3px 0 0 var(--d1-accent, var(--theme--primary)); }
.lab { font-weight: 600; }
.det { margin-left: auto; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.none { margin: 0; padding: 10px 8px; color: var(--d1-dim); }
.none.empty { padding: 0; }
</style>
