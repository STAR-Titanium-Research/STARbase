<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { EXPLORER_HOST } from '../host';
import { useRequestGate } from '../composables/useRequestGate';
import { searchPeople } from '../access/accessApi';
import { LOGINLESS_NOTE, addable, isLoginless, type AccessList, type PersonHit } from '../access/accessModel';
import { moveIndex } from '../finder/finderNav';

// The add box of the "Who has access" dialog: a combobox that searches active People by name (the same /items/people the People
// page reads). A person with no login can be picked and is marked "can't sign in yet": the grant starts working the day an admin
// links a login to them. People already on the list are left out; for a transfer (`entries: false`) only the owner is.
// Enter picks the highlighted person, the arrow keys move, Escape closes the list (and only then: a second Escape closes the dialog).
const props = withDefaults(defineProps<{ list: Pick<AccessList, 'owner' | 'entries'> | null; label: string; placeholder?: string; entries?: boolean; disabled?: boolean }>(), {
	placeholder: 'Add people by name…',
	entries: true,
});
const emit = defineEmits<{ (e: 'pick', person: PersonHit): void }>();

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('AccessPersonPicker needs an ExplorerHost: render it inside ExplorerView');

const uid = `d1-access-pick-${Math.random().toString(36).slice(2, 8)}`;
const text = ref('');
const hits = ref<PersonHit[]>([]);
const searching = ref(false);
const failed = ref('');
const open = ref(false);
const active = ref(-1);
const input = ref<HTMLInputElement | null>(null);
const gate = useRequestGate();
let timer: ReturnType<typeof setTimeout> | null = null;

const shown = computed(() => {
	const list = props.list ?? { owner: null, entries: [] };
	return addable(hits.value, props.entries ? list : { owner: list.owner, entries: [] });
});
const activeId = computed(() => (active.value >= 0 && active.value < shown.value.length ? `${uid}-opt-${active.value}` : undefined));

watch(text, (value) => {
	if (timer) clearTimeout(timer);
	failed.value = '';
	if (!value.trim()) {
		gate.cancel();
		hits.value = [];
		searching.value = false;
		open.value = false;
		return;
	}
	searching.value = true;
	timer = setTimeout(async () => {
		const token = gate.begin();
		const res = await searchPeople(host.api, value);
		if (!gate.isCurrent(token)) return;
		searching.value = false;
		if (res.ok) {
			hits.value = res.data;
			failed.value = '';
		} else {
			hits.value = [];
			failed.value = res.message;
		}
		open.value = true;
		active.value = shown.value.length ? 0 : -1;
	}, 250);
});
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	gate.cancel();
});

function pick(person: PersonHit) {
	emit('pick', person);
	text.value = '';
	hits.value = [];
	open.value = false;
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		if (!shown.value.length) return;
		e.preventDefault();
		open.value = true;
		active.value = moveIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, shown.value.length);
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		const person = shown.value[active.value];
		if (open.value && person) pick(person);
	} else if (e.key === 'Escape' && open.value) {
		e.preventDefault();
		e.stopPropagation();
		open.value = false;
	}
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
	<div class="d1-access-pick">
		<input
			ref="input"
			v-model="text"
			type="text"
			role="combobox"
			class="q"
			:placeholder="placeholder"
			:aria-label="label"
			aria-autocomplete="list"
			:aria-expanded="open && shown.length > 0"
			:aria-controls="`${uid}-list`"
			:aria-activedescendant="activeId"
			autocomplete="off"
			spellcheck="false"
			:disabled="disabled"
			@keydown="onKeydown"
			@focus="open = shown.length > 0"
		/>
		<ul v-show="open && shown.length" :id="`${uid}-list`" class="opts" role="listbox" :aria-label="`${label}: matches`">
			<!-- mousedown.prevent: a click must not take focus off the box before the pick lands. -->
			<li
				v-for="(p, i) in shown"
				:id="`${uid}-opt-${i}`"
				:key="p.person_id"
				role="option"
				class="opt"
				:class="{ on: i === active }"
				:aria-selected="i === active"
				@mousedown.prevent
				@mousemove="active = i"
				@click="pick(p)"
			>
				<span class="n">{{ p.full_name }}</span>
				<span v-if="isLoginless(p)" class="tag">{{ LOGINLESS_NOTE }}</span>
			</li>
		</ul>
		<p class="hint" role="status" aria-live="polite">
			<template v-if="failed">{{ failed }}</template>
			<template v-else-if="searching">Searching…</template>
			<template v-else-if="text.trim() && open && !shown.length">No one matches (people already on the list are left out).</template>
		</p>
	</div>
</template>

<style scoped>
.d1-access-pick { position: relative; min-width: 0; flex: 1; }
.q {
	width: 100%; box-sizing: border-box; height: 38px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px);
}
.q:focus { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.opts {
	position: absolute; z-index: 2; left: 0; right: 0; margin: 4px 0 0; padding: 4px; list-style: none; max-height: 240px; overflow-y: auto;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.opt { display: flex; align-items: baseline; gap: 10px; padding: 6px 8px; border-radius: 6px; font-size: var(--fs-md, 13px); cursor: pointer; }
.opt.on { background: var(--d1-tile); outline: 1px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); white-space: nowrap; }
.hint { margin: 4px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.hint:empty { display: none; }
</style>
