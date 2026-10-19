<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { OrphanRow } from './attachModel';
import { restoreFocus as giveFocusBack } from './focusCanvas';

// From database… (redesign R8): a compact searchable list of the recorded operations that have no input sample yet (planned or done), read
// as the signed-in user, so the list holds only what this person may see. Each row says what it is (code, method, day, planned or done,
// who owns it, the sample it made); one that cannot be attached here is listed greyed with the reason. Choosing a row attaches it to the
// sample the picker was opened for, or leaves it on the canvas (opened unconnected). Type to narrow, ArrowUp/ArrowDown move, Enter picks,
// Esc closes.
const props = defineProps<{
	/** What it is for: "Attach to PS-001" / "Add to the canvas". */
	heading: string;
	/** One page of the operations, narrowed by the words typed (the server's search). `offset` is how many came before. */
	search: (query: string, offset: number) => Promise<{ rows: OrphanRow[]; more: boolean }>;
	/** Why a row cannot be attached here, or null. */
	reasonOf: (row: OrphanRow) => string | null;
	/** What went wrong with the last pick. */
	problem?: string;
	/** A pick is being read. */
	busy?: boolean;
	restoreFocus?: () => void;
}>();
const emit = defineEmits<{ pick: [row: OrphanRow]; close: [] }>();

const uid = useId();
const query = ref('');
const rows = ref<OrphanRow[]>([]);
const more = ref(false);
const loading = ref(false);
const failed = ref(false);
/** Rows are shown only once the first read answered: "Nothing found" is not said while it is on its way. */
const answered = ref(false);
const active = ref(-1);
let timer: ReturnType<typeof setTimeout> | null = null;
let asked = 0;

async function load(offset: number): Promise<void> {
	const mine = ++asked;
	loading.value = true;
	failed.value = false;
	try {
		const page = await props.search(query.value.trim(), offset);
		if (mine !== asked) return;
		rows.value = offset ? [...rows.value, ...page.rows] : page.rows;
		more.value = page.more;
		answered.value = true;
	} catch {
		if (mine !== asked) return;
		failed.value = true;
		if (!offset) rows.value = [];
	} finally {
		if (mine === asked) loading.value = false;
	}
}
// The first read is at once; typing asks again a moment after the last key.
onMounted(() => void load(0));
watch(query, () => {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => void load(0), 200);
});

const items = computed(() => rows.value.map((r) => ({ r, why: props.reasonOf(r) })));
const firstChoosable = () => items.value.findIndex((i) => !i.why);
watch(items, (list) => void (active.value = list.findIndex((i) => !i.why)), { immediate: true });

const message = computed(() => {
	if (failed.value) return 'The list could not be read. Try again.';
	if (loading.value && !answered.value) return 'Reading the operations…';
	if (answered.value && !rows.value.length) return query.value.trim() ? 'No operation without an input sample matches.' : 'No operation without an input sample that you can see.';
	return '';
});

const optionId = (i: number) => `${uid}-opt-${i}`;
const list = ref<HTMLElement | null>(null);
function move(dir: 1 | -1): void {
	const n = items.value.length;
	for (let step = 1; step <= n; step++) {
		const i = (((active.value < 0 ? (dir === 1 ? -1 : 0) : active.value) + dir * step) % n + n) % n;
		if (!items.value[i].why) {
			active.value = i;
			void nextTick(() => list.value?.querySelector(`[id="${optionId(i)}"]`)?.scrollIntoView?.({ block: 'nearest' }));
			return;
		}
	}
}
function choose(i: number): void {
	const item = items.value[i];
	if (!item || item.why || props.busy) return;
	emit('pick', item.r);
}
function onKey(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		move(e.key === 'ArrowDown' ? 1 : -1);
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		choose(active.value >= 0 ? active.value : firstChoosable());
	} else if (e.key === 'Tab') {
		const focusable = [...(box.value?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])].filter((el) => el.tabIndex >= 0);
		if (!focusable.length) return e.preventDefault();
		const at = focusable.indexOf(document.activeElement as HTMLElement);
		const next = focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
		e.preventDefault();
		next.focus();
	}
}

const input = ref<HTMLInputElement | null>(null);
const box = ref<HTMLElement | null>(null);
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
onMounted(() => input.value?.focus());
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	giveFocusBack(opener, () => props.restoreFocus?.());
});

const day = (d: string | null): string => d ?? 'no date';
</script>

<template>
	<div class="pm-attach-back" @pointerdown.self="emit('close')">
		<div ref="box" class="d1-kit d1-process-map pm-attach" role="dialog" aria-modal="true" aria-label="From database" @keydown="onKey">
			<div class="bar">
				<h2>From database</h2>
				<span class="hint">{{ heading }}</span>
				<button type="button" class="x" aria-label="Close" @click="emit('close')"><v-icon name="close" small /></button>
			</div>
			<p class="what">Recorded operations that have no input sample yet. Choosing one makes the sample an input of it; nothing else about it changes.</p>
			<input
				ref="input"
				v-model="query"
				class="q"
				type="text"
				role="combobox"
				autocomplete="off"
				spellcheck="false"
				placeholder="Operation code, method or the sample it made…"
				aria-label="Search operations"
				aria-expanded="true"
				:aria-controls="`${uid}-list`"
				:aria-activedescendant="active >= 0 ? optionId(active) : undefined"
			/>
			<div :id="`${uid}-list`" ref="list" class="list" role="listbox" aria-label="Operations without an input sample" :aria-busy="loading">
				<button
					v-for="(it, i) in items"
					:id="optionId(i)"
					:key="it.r.id"
					type="button"
					role="option"
					class="opt"
					:class="{ on: i === active, off: !!it.why }"
					:data-operation="it.r.id"
					:aria-selected="i === active"
					:aria-disabled="!!it.why || undefined"
					tabindex="-1"
					@mousemove="!it.why && (active = i)"
					@click="choose(i)"
				>
					<span class="code">{{ it.r.code }}</span>
					<span class="method">{{ it.r.method }}</span>
					<span class="state" :class="it.r.workState">{{ it.r.workState === 'planned' ? 'Planned' : 'Done' }}</span>
					<span class="meta">{{ day(it.r.date) }}<template v-if="it.r.owner"> · {{ it.r.owner }}</template><template v-if="it.r.output"> · makes {{ it.r.output.code }}</template></span>
					<span v-if="it.why" class="why">{{ it.why }}</span>
				</button>
				<button v-if="more" type="button" class="more" :disabled="loading" @click="load(rows.length)">{{ loading ? 'Reading…' : 'Show more' }}</button>
			</div>
			<!-- One status region, always mounted: a live region that appears together with its text is often not announced. -->
			<p class="none" :class="{ bad: failed || !!problem, empty: !message && !problem }" role="status" aria-live="polite" aria-atomic="true">{{ problem || message }}</p>
			<p v-if="busy" class="none">Reading that operation…</p>
		</div>
	</div>
</template>

<style scoped>
.pm-attach-back { position: fixed; inset: 0; z-index: 56; display: grid; place-items: center; background: color-mix(in srgb, var(--theme--background) 55%, transparent); backdrop-filter: blur(1px); }
.pm-attach {
	display: flex;
	flex-direction: column;
	gap: 8px;
	box-sizing: border-box;
	width: min(640px, 94vw);
	max-height: min(640px, 88vh);
	max-height: min(640px, 88dvh);
	padding: 12px 14px;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 14px;
	box-shadow: var(--d1-shadow-lg, 0 18px 50px rgb(0 0 0 / 0.3));
	font-size: var(--fs-md, 13px);
}
.bar { display: flex; align-items: center; gap: 12px; }
.bar h2 { margin: 0; font-size: var(--fs-lg, 15px); }
.hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.x { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer; }
.x:hover, .x:focus-visible { background: var(--d1-tile); outline: none; }
.what { margin: 0; color: var(--d1-dim); font-size: var(--fs-sm, 12px); line-height: 1.4; }
.q {
	box-sizing: border-box; width: 100%; padding: 7px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
.q:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
.list { display: flex; flex-direction: column; flex: 1; min-height: 120px; overflow: auto; }
.opt {
	display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px;
	background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.opt.on { background: var(--d1-tint); box-shadow: inset 3px 0 0 var(--d1-accent, var(--theme--primary)); }
.opt.off { cursor: default; opacity: 0.6; }
.code { font-weight: 700; font-family: var(--theme--fonts--monospace--font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.method { grid-column: 1; color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.state { grid-row: 1; grid-column: 2; align-self: start; padding: 0 8px; border-radius: 999px; font-size: var(--fs-xs, 11px); font-weight: 700; border: 1px solid var(--d1-line); }
.state.planned { border-style: dashed; color: var(--d1-dim); }
.state.done { color: var(--d1-ok, inherit); border-color: var(--d1-ok, var(--d1-line)); }
.meta { grid-column: 1 / -1; color: var(--d1-dim); font-size: var(--fs-xs, 11px); }
.why { grid-column: 1 / -1; font-size: var(--fs-xs, 11px); color: var(--d1-bad); }
.more { margin: 6px auto 0; padding: 5px 14px; border: 1px solid var(--d1-line); border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
.more:hover:not(:disabled), .more:focus-visible { background: var(--d1-tile); outline: none; }
.none { margin: 0; padding: 4px 2px; color: var(--d1-dim); }
.none.bad { color: var(--d1-bad); }
.none.empty { padding: 0; }
</style>
