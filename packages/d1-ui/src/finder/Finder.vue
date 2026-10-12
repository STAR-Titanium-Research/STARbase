<script setup lang="ts">
// The Ctrl K finder (spec section 6): a modal search over pages, saved views and records. The host
// page mounts it while it is open (v-if) and listens for `close`; state therefore starts fresh on
// every open. It reads the ExplorerHost like the sidebar does and goes to a hit with host.navigate.
//
// Keyboard: the input keeps focus the whole time and the arrow keys move an "active" option
// (aria-activedescendant), so there is nothing else to tab to and Tab is simply held in the input.
// Focus goes back to whatever had it before the dialog opened.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import '../components/tokens.css';
import { EXPLORER_HOST } from '../host';
import { MIN_QUERY } from './finder';
import type { FinderHit } from './finder';
import { moveIndex, toSections } from './finderNav';
import { useFinder } from './useFinder';
import { useExplorerNav } from '../nav/useExplorerNav';

const emit = defineEmits<{ (e: 'close'): void }>();

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('Finder needs an ExplorerHost: render it inside ExplorerView');
const { nav, visible } = useExplorerNav(host);
const { query, hits, loading, searchable } = useFinder(host, nav, visible);

// Unique per instance, so two Explorer pages never share an id.
const uid = `d1-finder-${Math.random().toString(36).slice(2, 8)}`;
const sections = computed(() => toSections(hits.value, uid));
const active = ref(-1);
const activeId = computed(() => (active.value >= 0 ? `${uid}-opt-${active.value}` : undefined));

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

// The best match is the one Enter opens; a new result list starts from it.
watch(hits, (h) => { active.value = h.length ? 0 : -1; });

watch(activeId, async (id) => {
	if (!id) return;
	await nextTick();
	list.value?.querySelector<HTMLElement>(`[id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
});

// What had focus when the dialog opened (the sidebar box, or a field when Ctrl K was pressed in it).
const opener = document.activeElement as HTMLElement | null;
onMounted(() => input.value?.focus());
onBeforeUnmount(() => {
	if (opener?.isConnected) opener.focus();
});

function pick(hit: FinderHit) {
	host!.navigate(hit.to);
	emit('close');
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		active.value = moveIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, hits.value.length);
	} else if (e.key === 'Enter') {
		// Enter that confirms an IME composition is not "open this".
		if (e.isComposing) return;
		e.preventDefault();
		const hit = hits.value[active.value];
		if (hit) pick(hit);
	} else if (e.key === 'Tab') {
		// The input is the only stop: focus stays in the dialog.
		e.preventDefault();
		input.value?.focus();
	}
}
</script>

<template>
	<Teleport to="body">
		<div class="d1-kit d1-finder-backdrop" @mousedown.self="emit('close')">
			<div class="d1-finder" role="dialog" aria-modal="true" aria-label="Find a record" @keydown="onKeydown">
				<input
					ref="input"
					v-model="query"
					class="q"
					type="text"
					role="combobox"
					aria-label="Find a record"
					aria-autocomplete="list"
					:aria-expanded="hits.length > 0"
					:aria-controls="`${uid}-list`"
					:aria-activedescendant="activeId"
					placeholder="Find a record, page or saved view…"
					autocomplete="off"
					spellcheck="false"
				/>

				<div :id="`${uid}-list`" ref="list" class="results" role="listbox" aria-label="Results">
					<div v-for="s in sections" :key="s.headingId" role="group" :aria-labelledby="s.headingId" class="grp">
						<div :id="s.headingId" class="head" role="presentation">{{ s.group }}</div>
						<!-- mousedown.prevent: a click must not take focus off the input. -->
						<div
							v-for="item in s.items"
							:id="item.id"
							:key="item.id"
							role="option"
							class="opt"
							:class="{ on: item.index === active }"
							:aria-selected="item.index === active"
							@mousedown.prevent
							@mousemove="active = item.index"
							@click="pick(item.hit)"
						>
							<span class="label">{{ item.hit.label }}</span>
							<span v-if="item.hit.detail" class="detail">{{ item.hit.detail }}</span>
						</div>
					</div>
				</div>

				<p class="hint" role="status" aria-live="polite">
					<template v-if="!searchable">Type at least {{ MIN_QUERY }} characters.</template>
					<template v-else-if="loading">Searching…</template>
					<template v-else-if="!hits.length">No matches</template>
				</p>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.d1-finder-backdrop {
	position: fixed; inset: 0; z-index: 9999;
	display: flex; align-items: flex-start; justify-content: center;
	padding: 12vh 16px 16px;
	background: rgba(0, 0, 0, 0.4);
	font-family: var(--theme--fonts--sans--font-family, inherit);
	color: var(--theme--foreground);
}
.d1-finder {
	width: min(560px, 100%); max-height: 70vh;
	display: flex; flex-direction: column;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius);
	background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
	overflow: hidden;
}
.q {
	width: 100%; box-sizing: border-box; height: 44px; padding: 0 16px;
	border: 0; border-bottom: 1px solid var(--d1-line); outline: none;
	background: transparent; color: inherit; font: inherit; font-size: var(--fs-lg, 15px);
}
.q:focus-visible { box-shadow: inset 0 -2px 0 var(--d1-accent, var(--theme--primary)); }
.results { overflow-y: auto; padding: 4px 8px; }
.head {
	padding: 8px 8px 2px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.06em; text-transform: uppercase; color: var(--d1-dim);
}
.opt {
	display: flex; align-items: baseline; gap: 10px; padding: 6px 8px; border-radius: 7px;
	font-size: var(--fs-md, 13px); cursor: pointer;
}
.opt.on { background: var(--d1-tile); outline: 1px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.hint { margin: 0; padding: 8px 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.hint:empty { display: none; }
</style>
