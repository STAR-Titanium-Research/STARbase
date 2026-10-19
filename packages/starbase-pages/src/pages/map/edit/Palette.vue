<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { draggable, type PaletteDrag } from './useAddDrag';
import type { MenuEntry } from './menuModel';
import TemplateManage from './TemplateManage.vue';
import type { TemplateScope } from './templates';

// The palette (redesign R1): the left dock of edit mode. A search box over the one catalog (samples, operations by process category, tests),
// every entry a drag source: drop it on the empty canvas (a floating card), on a free socket (connected there) or on a wire (inserted between
// its ends). A mouse drags; the keyboard reaches every entry with Tab and Enter adds it (next to the selected card, else at the middle of the
// canvas). The dock folds to a rail, and remembers that per person. Presentational: the page owns what the entries do.
const props = defineProps<{
	entries: MenuEntry[];
	/** Section headers (nothing typed). */
	grouped: boolean;
	folded: boolean;
	/** The entry being dragged, for the chip at the pointer. */
	drag: PaletteDrag | null;
	/** The click a finished drag leaves behind on its entry is not an add: true once for it. */
	consumeClick: () => boolean;
	/** Templates (R7): what was just done to one, or what failed, said above the list. */
	templateNotice?: string;
	templateFailed?: boolean;
	templateBusy?: boolean;
	/** The kind of the selected container on the canvas, and what it is called: a template of that kind can take its settings. */
	selectedKind?: 'operation' | 'test' | null;
	selectedTitle?: string;
}>();
const query = defineModel<string>('query', { default: '' });
const emit = defineEmits<{
	toggle: [];
	add: [entry: MenuEntry];
	drag: [entry: MenuEntry, e: PointerEvent];
	'template-rename': [id: string, name: string];
	'template-scope': [id: string, scope: TemplateScope];
	'template-replace': [id: string];
	'template-delete': [id: string];
	'template-dismiss': [];
}>();
/** The template whose controls are open. */
const managing = ref<string | null>(null);
const search = ref<HTMLInputElement | null>(null);
/** Closes a template's controls and puts focus where the keyboard can go on: its ⋯ button, or the search box when the template is gone. */
async function closeManage(id: string, then: 'button' | 'search' = 'button'): Promise<void> {
	managing.value = null;
	await nextTick();
	if (then === 'search') search.value?.focus();
	else list.value?.querySelector<HTMLElement>(`[data-tm="${CSS.escape(id)}"]`)?.focus();
}

const rows = computed(() => props.entries.map((e, i) => ({ e, head: props.grouped && (i === 0 || props.entries[i - 1].section !== e.section) ? e.section : null })));
const list = ref<HTMLElement | null>(null);

function click(e: MenuEntry) {
	if (props.consumeClick()) return;
	emit('add', e);
}
/** ArrowUp/ArrowDown move between the entries (and from the search box into the list), as in a list. */
function onKey(ev: KeyboardEvent) {
	if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
	// Only the search box and the entries are a list: arrows inside a template's controls (the scope radios, a field) are theirs.
	const t = ev.target as HTMLElement | null;
	if (!t?.matches?.('.q') && !t?.closest?.('.pe')) return;
	const items = [...(list.value?.querySelectorAll<HTMLElement>('.pe') ?? [])];
	if (!items.length) return;
	ev.preventDefault();
	const at = items.indexOf(document.activeElement as HTMLElement);
	const next = at < 0 ? (ev.key === 'ArrowDown' ? 0 : items.length - 1) : at + (ev.key === 'ArrowDown' ? 1 : -1);
	items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
}
const chip = computed(() => (props.drag ? (props.drag.ok === false ? 'bad' : props.drag.ok ? 'ok' : 'idle') : ''));
</script>

<template>
	<aside class="d1-kit d1-process-map pm-palette" :class="{ folded }" aria-label="Palette" @keydown="onKey">
		<div class="top">
			<span v-if="!folded" class="ttl">Palette</span>
			<button type="button" class="fold" :aria-expanded="!folded" :aria-label="folded ? 'Open the palette' : 'Fold the palette'" :title="folded ? 'Open the palette' : 'Fold the palette'" @click="emit('toggle')">
				<v-icon :name="folded ? 'chevron_right' : 'chevron_left'" small />
				<span v-if="folded" class="rail">Palette</span>
			</button>
		</div>
		<template v-if="!folded">
			<input ref="search" v-model="query" class="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search…" aria-label="Search the palette" @keydown.esc.stop="query = ''" />
			<p class="hint">Drag onto the canvas, a socket or a wire. Enter adds.</p>
			<p v-if="templateNotice" class="note" :class="{ bad: templateFailed }" role="status" data-template-notice>
				<span>{{ templateNotice }}</span>
				<button type="button" class="x" aria-label="Dismiss" @click="emit('template-dismiss')"><v-icon name="close" x-small /></button>
			</p>
			<div ref="list" class="list" role="group" aria-label="Things to add">
				<template v-for="r in rows" :key="r.e.id">
					<div v-if="r.head" class="sec" role="presentation">{{ r.head }}</div>
					<div class="pr">
						<button
							type="button"
							class="pe"
							:class="{ drag: draggable(r.e), grey: !!r.e.warn }"
							:data-entry="r.e.id"
							:title="draggable(r.e) ? 'Drag onto the canvas, a socket or a wire. Enter adds it.' : r.e.detail"
							@pointerdown="draggable(r.e) && emit('drag', r.e, $event)"
							@click="click(r.e)"
						>
							<span class="lab">{{ r.e.label }}</span>
							<span v-if="r.e.detail" class="det">{{ r.e.detail }}</span>
							<span v-if="!grouped && r.e.section" class="cat">{{ r.e.section }}</span>
							<span v-if="r.e.warn" class="warn" data-warning>{{ r.e.warn }}</span>
						</button>
						<button
							v-if="r.e.template?.mine"
							type="button"
							class="tm"
							:data-tm="r.e.template.id"
							:aria-label="`Manage the template ${r.e.template.name}`"
							:aria-expanded="managing === r.e.template.id"
							title="Rename, who can use it, replace, delete"
							@click="managing = managing === r.e.template.id ? null : r.e.template.id"
						>
							<v-icon name="more_horiz" x-small />
						</button>
						<TemplateManage
							v-if="r.e.template && managing === r.e.template.id"
							:info="r.e.template"
							:selected-kind="selectedKind ?? null"
							:selected-title="selectedTitle ?? ''"
							:busy="!!templateBusy"
							@rename="(n) => emit('template-rename', r.e.template!.id, n)"
							@scope="(sc) => emit('template-scope', r.e.template!.id, sc)"
							@replace="emit('template-replace', r.e.template!.id)"
							@delete="(emit('template-delete', r.e.template!.id), closeManage(r.e.template!.id, 'search'))"
							@close="closeManage(r.e.template!.id)"
						/>
					</div>
				</template>
				<p v-if="!rows.length" class="none" role="status">Nothing fits what you typed.</p>
			</div>
		</template>
		<Teleport to="body">
			<div v-if="drag" class="d1-kit d1-process-map pm-chip" :class="chip" :style="{ left: `${drag.x + 14}px`, top: `${drag.y + 14}px` }" aria-hidden="true">
				<strong>{{ drag.entry.label }}</strong>
				<span v-if="drag.reason" class="why">{{ drag.reason }}</span>
				<span v-else-if="drag.over === 'wire'" class="why">Insert between the two ends</span>
				<span v-else-if="drag.over === 'socket'" class="why">Connect here</span>
				<span v-else-if="drag.over === 'canvas'" class="why">Add here</span>
			</div>
		</Teleport>
	</aside>
</template>

<style scoped>
.pm-palette {
	display: flex;
	flex-direction: column;
	flex: none;
	gap: 6px;
	box-sizing: border-box;
	width: 236px;
	padding: 8px;
	overflow: hidden;
	/* No taller than the canvas beside it (the same height the page gives it): the list scrolls inside the dock, with a finger too, and the page does not grow with the catalog. */
	max-height: max(420px, calc(100vh - var(--d1-header-offset, 72px) - 130px));
	max-height: max(420px, calc(100dvh - var(--d1-header-offset, 72px) - 130px));
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border-right: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-md, 13px);
}
.pm-palette.folded { width: 36px; padding: 6px 4px; align-items: center; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.folded .top { flex-direction: column; }
.fold {
	display: inline-flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px;
	padding: 4px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer;
}
.fold:hover, .fold:focus-visible { background: var(--d1-tile); outline: none; }
.rail { writing-mode: vertical-rl; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--d1-dim); }
.ttl { padding: 0 2px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.q {
	box-sizing: border-box; width: 100%; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
.q:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
.hint { margin: 0; padding: 0 2px; color: var(--d1-dim); font-size: var(--fs-xs, 11px); line-height: 1.35; }
.list { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
.sec { padding: 8px 4px 3px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.pr { display: flex; flex-wrap: wrap; align-items: flex-start; }
.pr > .pe { flex: 1; width: auto; min-width: 0; }
.tm { flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px; margin: 3px 0 0 2px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--d1-dim); cursor: pointer; }
.tm:hover, .tm:focus-visible, .tm[aria-expanded='true'] { background: var(--d1-tile); color: inherit; outline: none; }
.note { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 4px 6px; border-radius: 6px; background: var(--d1-tint); font-size: var(--fs-xs, 11px); line-height: 1.35; }
.note.bad { color: var(--d1-bad); }
.note span { flex: 1; }
.note .x { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
/* A template that names a retired machine or tool or a used-up edge: still there to use, greyed, with the reason under it. */
.pe.grey .lab, .pe.grey .det { opacity: 0.6; }
.warn { flex-basis: 100%; font-size: var(--fs-xs, 11px); color: var(--d1-warn, var(--theme--warning)); }
.pe {
	display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 8px; width: 100%; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px;
	background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: pan-y;
}
.pe.drag { cursor: grab; }
/* A finger scrolls the list (touch-action above) and carries an entry only after a long press: no selection or callout in the way. */
@media (pointer: coarse) { .pe { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; } }
.pe:hover, .pe:focus-visible { background: var(--d1-tile); border-color: var(--d1-line); outline: none; }
.pe:focus-visible { border-color: var(--d1-accent, var(--theme--primary)); }
.lab { font-weight: 600; }
.det { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.cat { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.none { margin: 0; padding: 10px 8px; color: var(--d1-dim); }
.pm-chip {
	position: fixed; z-index: 80; display: flex; flex-direction: column; max-width: 260px; padding: 5px 10px; border-radius: 8px; pointer-events: none;
	background: var(--d1-surface, var(--theme--background)); color: var(--theme--foreground); border: 1.5px dashed var(--d1-accent, var(--theme--primary));
	box-shadow: var(--d1-shadow-lg, 0 4px 14px rgb(0 0 0 / 0.18)); font-size: var(--fs-sm, 12px);
}
.pm-chip.ok { border-style: solid; border-color: var(--d1-ok); }
.pm-chip.bad { border-color: var(--d1-bad); }
.pm-chip.bad .why { color: var(--d1-bad); }
.why { font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
