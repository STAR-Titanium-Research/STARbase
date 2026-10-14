<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useExplorerHost } from '../../host';
import { useRequestGate } from '../../composables/useRequestGate';
import { errorText, isForbidden } from '../../format';
import { moveIndex } from '../../finder/finderNav';
import type { FormField } from '../fieldModel';
import { optionFor, pickerSource, searchOptions } from '../recordSource';
import type { PickerOption } from '../recordSource';

// The picker of a many-to-one (Material, Method, Owner, Input sample): a combobox that searches the related
// collection through the host's API (the finder's own query where the finder knows the collection) and shows the
// chosen record by its code or name, not its id. The value is the record's key, or null. Enter picks the
// highlighted row, the arrow keys move, Escape closes the list.
const props = defineProps<{
	field: FormField;
	/** The record's key, or null. */
	value: string | null;
	id: string;
	disabled?: boolean;
	/** The value is inherited (not the person's own): shown greyed. */
	inherited?: boolean;
	/** The live required state (a condition can change it) and the aria hooks the form passes (see FieldInput). */
	required?: boolean;
	invalid?: boolean;
	describedby?: string;
}>();
const emit = defineEmits<{ (e: 'update:value', value: string | null): void; (e: 'blur'): void }>();

const host = useExplorerHost();
const source = computed(() => (props.field.related ? pickerSource(props.field.related) : null));
const noun = computed(() => (props.field.kind === 'person' ? 'person' : props.field.label.toLowerCase()));

const label = ref('');
const text = ref('');
const typing = ref(false);
const options = ref<PickerOption[]>([]);
const searching = ref(false);
const failed = ref('');
const open = ref(false);
// The list is open only while the box has focus: an answer that arrives after the person has left is dropped.
const focused = ref(false);
const active = ref(-1);
// The option just picked, so its label is not read again once the list is gone.
let picked: PickerOption | null = null;
const gate = useRequestGate();
const labelGate = useRequestGate();
let timer: ReturnType<typeof setTimeout> | null = null;

const shown = computed(() => (typing.value ? text.value : label.value || (props.value ?? '')));
const listId = computed(() => `${props.id}-list`);
const activeId = computed(() => (active.value >= 0 && active.value < options.value.length ? `${props.id}-opt-${active.value}` : undefined));

// The chosen record's label: from the last search when it is in it, else one read by key. A record that cannot be
// read (the person may not see it) still holds its key: the id is shown rather than nothing.
async function resolveLabel(): Promise<void> {
	const token = labelGate.begin();
	const id = props.value;
	const src = source.value;
	if (!id || !src) {
		label.value = '';
		return;
	}
	const known = options.value.find((o) => o.id === id) ?? (picked?.id === id ? picked : undefined);
	if (known) {
		label.value = known.label;
		return;
	}
	const opt = await optionFor(host.api, src, id);
	if (!labelGate.isCurrent(token)) return;
	label.value = opt?.label ?? id;
}
onMounted(resolveLabel);
watch(() => props.value, resolveLabel);

async function search(q: string): Promise<void> {
	const src = source.value;
	if (!src) return;
	const token = gate.begin();
	searching.value = true;
	failed.value = '';
	try {
		const found = await searchOptions(host.api, src, q);
		if (!gate.isCurrent(token)) return;
		options.value = found;
		active.value = found.length ? 0 : -1;
	} catch (e) {
		if (!gate.isCurrent(token)) return;
		options.value = [];
		failed.value = isForbidden(e) ? `You can't list ${noun.value}s.` : `Could not search: ${errorText(e)}`;
	}
	searching.value = false;
	open.value = focused.value;
}

function onInput(e: Event): void {
	text.value = (e.target as HTMLInputElement).value;
	typing.value = true;
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => void search(text.value), 200);
}
function onFocus(e: FocusEvent): void {
	if (props.disabled) return;
	focused.value = true;
	(e.target as HTMLInputElement).select();
	void search('');
}
// Leaving closes the list and forgets it: a search still on its way is dropped, and the next focus asks afresh.
function close(): void {
	typing.value = false;
	open.value = false;
	options.value = [];
	active.value = -1;
	failed.value = '';
	searching.value = false;
	gate.cancel();
	if (timer) clearTimeout(timer);
}
function onBlur(): void {
	focused.value = false;
	close();
	emit('blur');
}
function pick(o: PickerOption): void {
	picked = o;
	label.value = o.label;
	emit('update:value', o.id);
	close();
}
function clear(): void {
	label.value = '';
	text.value = '';
	emit('update:value', null);
}
function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		if (!options.value.length) return;
		e.preventDefault();
		open.value = true;
		active.value = moveIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, options.value.length);
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		const hit = options.value[active.value];
		if (open.value && hit) pick(hit);
	} else if (e.key === 'Escape' && open.value) {
		e.preventDefault();
		e.stopPropagation();
		open.value = false;
	}
}
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	gate.cancel();
	labelGate.cancel();
});
</script>

<template>
	<div class="d1-record-pick" :class="{ inherited }">
		<div class="box">
			<input
				:id="id"
				:value="shown"
				type="text"
				role="combobox"
				class="q"
				:placeholder="`Search ${noun}s…`"
				:aria-label="field.label"
				aria-autocomplete="list"
				:aria-expanded="open && options.length > 0"
				:aria-controls="listId"
				:aria-activedescendant="activeId"
				:aria-required="required || undefined"
				:aria-invalid="invalid || undefined"
				:aria-describedby="describedby"
				autocomplete="off"
				spellcheck="false"
				:disabled="disabled || !source"
				@input="onInput"
				@focus="onFocus"
				@blur="onBlur"
				@keydown="onKeydown"
			/>
			<button v-if="value && !disabled" type="button" class="clear" :aria-label="`Clear ${field.label}`" @mousedown.prevent @click="clear">×</button>
		</div>
		<ul v-show="open && options.length" :id="listId" class="opts" role="listbox" :aria-label="`${field.label}: matches`">
			<!-- mousedown.prevent: a click must not take focus off the box before the pick lands. -->
			<li
				v-for="(o, i) in options"
				:id="`${id}-opt-${i}`"
				:key="o.id"
				role="option"
				class="opt"
				:class="{ on: i === active }"
				:aria-selected="o.id === value"
				@mousedown.prevent
				@mousemove="active = i"
				@click="pick(o)"
			>
				<span class="n">{{ o.label }}</span>
				<span v-if="o.detail" class="sub">{{ o.detail }}</span>
			</li>
		</ul>
		<p class="hint" role="status" aria-live="polite">
			<template v-if="failed">{{ failed }}</template>
			<template v-else-if="searching">Searching…</template>
			<template v-else-if="open && typing && !options.length">Nothing matches.</template>
		</p>
	</div>
</template>

<style scoped>
.d1-record-pick { position: relative; min-width: 0; }
.box { position: relative; display: flex; align-items: center; }
.q {
	width: 100%; box-sizing: border-box; height: 34px; padding: 0 28px 0 10px;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px);
}
.q:focus { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.q:disabled { opacity: 0.7; }
.q[aria-invalid='true'] { border-color: var(--d1-bad); }
.inherited .q { color: var(--d1-dim); font-style: italic; }
.clear {
	position: absolute; right: 4px; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
	color: var(--d1-dim); font-size: var(--fs-lg, 15px); line-height: 1; cursor: pointer;
}
.clear:hover { background: var(--d1-tile); color: inherit; }
.opts {
	position: absolute; z-index: 3; left: 0; right: 0; margin: 4px 0 0; padding: 4px; list-style: none; max-height: 240px; overflow-y: auto;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); box-shadow: var(--d1-shadow, 0 2px 6px rgba(0, 0, 0, 0.1));
}
.opt { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; font-size: var(--fs-md, 13px); cursor: pointer; }
.opt.on { background: var(--d1-tile); outline: 1px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sub { margin-left: auto; font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.hint { margin: 4px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.hint:empty { display: none; }
</style>
