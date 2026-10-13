<script setup lang="ts">
// The Ctrl K finder (spec section 6): a modal search over pages, saved views and records. The host
// page mounts it while it is open (v-if) and listens for `close`; state therefore starts fresh on
// every open. It reads the ExplorerHost like the sidebar does and goes to a hit with host.navigate.
//
// Keyboard: the input keeps focus while typing and the arrow keys move an "active" option
// (aria-activedescendant). The only other stops are the Scan button and a result card's button, and Tab
// cycles through them without leaving the dialog.
// Focus goes back to whatever had it before the dialog opened.
//
// A scanned label: a USB (keyboard) scanner types the label's lines with Enter (CR) between them,
// and a paste carries real line breaks. So the box is a one-row textarea that keeps line breaks, Enter
// while the text is a D1 label adds a line instead of opening a hit, and once the typing stops (or on a
// paste) the label's sample is opened, or the decoded label and the reason are shown. See useFinder.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import '../components/tokens.css';
import { useExplorerHost } from '../host';
import { MIN_QUERY } from './finder';
import ScanResultCard from './ScanResultCard.vue';
import type { FinderHit } from './finder';
import { isTypingKey, moveIndex, toSections } from './finderNav';
import { flattenLines, isScanStarted, normalizeScan } from './scan';
import { useFinder } from './useFinder';
import { useExplorerNav } from '../nav/useExplorerNav';

const props = defineProps<{ canScan?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'scan'): void }>();

const host = useExplorerHost();
const { nav, visible } = useExplorerNav(host);
const { query, hits, loading, searchable, scan, scanning, readScanNow } = useFinder(host, nav, visible, {
	onOpen: (to) => {
		host.navigate(to);
		emit('close');
	},
	// The scanned text stays in the box: select it, so the next scan replaces it.
	onSettled: () => void nextTick(() => input.value?.select()),
});

// Unique per instance, so two Explorer pages never share an id.
const uid = `d1-finder-${Math.random().toString(36).slice(2, 8)}`;
const sections = computed(() => toSections(hits.value, uid));
const active = ref(-1);
const activeId = computed(() => (active.value >= 0 ? `${uid}-opt-${active.value}` : undefined));

const input = ref<HTMLTextAreaElement | null>(null);
const list = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);

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

function openTo(to: string) {
	host.navigate(to);
	emit('close');
}

function pick(hit: FinderHit) {
	host.navigate(hit.to);
	emit('close');
}

// Pasted text is taken whole: a label arrives as one value, not as keystrokes, and a plain text box
// would turn its line breaks into spaces.
function onPaste(e: ClipboardEvent) {
	const text = e.clipboardData?.getData('text') ?? '';
	if (!isScanStarted(text)) {
		// Ordinary text keeps behaving as in a one-line input: line breaks become spaces.
		const flat = flattenLines(text);
		if (flat === text) return;
		e.preventDefault();
		insertAtCaret(flat);
		return;
	}
	e.preventDefault();
	query.value = normalizeScan(text);
	readScanNow();
}

// Put text into the box at the caret, replacing the selection, and focus it. The DOM value is changed
// synchronously (not through v-model's next render), so keys that arrive right behind it, as from a
// scanner, land after this text and do not replace the selection a second time.
function insertAtCaret(text: string) {
	const el = input.value;
	if (!el) {
		query.value += text;
		return;
	}
	el.focus();
	el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
	query.value = el.value;
}

// A touch keyboard's Enter / Search key may arrive only as a line-break edit, with no Enter keydown.
// Outside a scanned label that is "open the best match", as in a one-line input.
function onBeforeinput(e: InputEvent) {
	if (e.inputType !== 'insertLineBreak' || scanning.value) return;
	e.preventDefault();
	openActive();
}

function openActive() {
	const hit = hits.value[active.value];
	if (hit) pick(hit);
}

function onKeydown(e: KeyboardEvent) {
	// Typing with a button focused (a scanner after a click on Scan, or on a result card's button): the
	// character goes into the box instead of the button being pressed by a later Enter in the label.
	if (e.target !== input.value && isTypingKey(e) && (e.target as HTMLElement | null)?.tagName === 'BUTTON') {
		e.preventDefault();
		insertAtCaret(e.key);
		return;
	}
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		active.value = moveIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, hits.value.length);
	} else if (e.key === 'Enter') {
		// Enter that confirms an IME composition is not "open this"; Enter on a button (Scan, Open sample) is that button's.
		if (e.isComposing || e.target !== input.value) return;
		// Part of a scanned label: the textarea adds the line break. Once the scan is settled the text is
		// selected, and Enter must not wipe it: it tries again (the connection may be back).
		if (scanning.value) {
			if (scan.value?.status === 'done') {
				e.preventDefault();
				readScanNow();
			}
			return;
		}
		e.preventDefault();
		openActive();
	} else if (e.key === 'Tab') {
		// Focus stays in the dialog: it cycles through the box and the buttons (Scan, a result card's Open).
		e.preventDefault();
		const stops = Array.from(dialog.value?.querySelectorAll<HTMLElement>('textarea, button:not([disabled])') ?? []);
		if (!stops.length) return;
		const at = stops.indexOf(document.activeElement as HTMLElement);
		const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
		stops[next].focus();
	}
}
</script>

<template>
	<Teleport to="body">
		<div class="d1-kit d1-finder-backdrop" @mousedown.self="emit('close')">
			<div ref="dialog" class="d1-finder" role="dialog" aria-modal="true" aria-label="Find a record" @keydown="onKeydown">
				<div class="bar">
				<!-- ARIA 1.1 combobox: a textarea may not carry role=combobox, so the wrapper does and the textarea
				     (a single-line textbox to a screen reader) is its text box. -->
				<div class="box" role="combobox" aria-haspopup="listbox" :aria-expanded="hits.length > 0" :aria-owns="`${uid}-list`">
					<textarea
						ref="input"
						v-model="query"
						class="q"
						rows="1"
						wrap="off"
						enterkeyhint="search"
						aria-label="Find a record"
						aria-multiline="false"
						aria-autocomplete="list"
						:aria-controls="`${uid}-list`"
						:aria-activedescendant="activeId"
						placeholder="Find a record, page or saved view…"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						@paste="onPaste"
						@beforeinput="onBeforeinput"
					/>
				</div>
				<!-- mousedown.prevent: a click must not take focus off the box. -->
				<button v-if="props.canScan" type="button" class="scan" aria-label="Scan a label with the camera" title="Scan a label with the camera" @mousedown.prevent @click="emit('scan')">
					<v-icon name="qr_code_scanner" small />
					<span>Scan</span>
				</button>
				</div>

				<div v-if="scanning" class="scanned">
					<p v-if="!scan || scan.status !== 'done'" class="hint" role="status" aria-live="polite">{{ scan?.status === 'resolving' ? 'Opening the sample…' : 'Reading the label… press Enter if it does not open.' }}</p>
					<ScanResultCard v-else-if="scan.outcome.kind !== 'open'" :outcome="scan.outcome" @open="openTo" />
				</div>

				<div v-show="!scanning" :id="`${uid}-list`" ref="list" class="results" role="listbox" aria-label="Results">
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

				<p v-if="!scanning" class="hint" role="status" aria-live="polite">
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
.bar { display: flex; align-items: stretch; border-bottom: 1px solid var(--d1-line); }
.bar:focus-within { box-shadow: inset 0 -2px 0 var(--d1-accent, var(--theme--primary)); }
/* One row that looks like an input; the textarea only exists so a pasted or scanned label keeps its line breaks. */
.box { flex: 1; min-width: 0; display: flex; }
.q {
	flex: 1; min-width: 0; box-sizing: border-box; height: 44px; padding: 12px 16px; resize: none; overflow: hidden;
	border: 0; outline: none; white-space: nowrap;
	background: transparent; color: inherit; font: inherit; font-size: var(--fs-lg, 15px); line-height: 20px;
}
.scan {
	display: flex; align-items: center; gap: 6px; margin: 6px 8px 6px 0; padding: 0 12px; flex: 0 0 auto;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.scan:hover { border-color: var(--d1-accent, var(--theme--primary)); }
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
