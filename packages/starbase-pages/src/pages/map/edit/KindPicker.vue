<script setup lang="ts">
import { computed } from 'vue';
import { processLabel } from '@d1/ui';
import { CATEGORIES, type MethodEntry, type TestTypeEntry } from './catalog';
import { splitTestType, type KindChoice } from './kindChange';

// The kind of a new operation, or the type of a new test, chosen on its card (spec K3): one dropdown, the methods grouped by process
// category and the test types by what the test does to the sample ("Destructive — Tensile" is Tensile under Destructive). It only reports
// the choice; the card's edit controls turn it into a change of the draft (EditMode.setKind).
const props = defineProps<{ kind: 'operation' | 'test'; value: string | null; methods: MethodEntry[]; testTypes: TestTypeEntry[] }>();
const emit = defineEmits<{ choose: [choice: KindChoice] }>();

interface Group {
	label: string;
	options: { value: string; text: string }[];
}

/** The test types' groups, in this order; any other prefix follows, and a type with no prefix is Other. */
const TEST_GROUPS = ['Non-destructive', 'Destructive', 'Dynamic', 'Other'];

const groups = computed<Group[]>(() => {
	if (props.kind === 'operation') {
		const groupOf = (category: MethodEntry['category']) => ({ label: category ? processLabel(category) : 'Other', options: props.methods.filter((m) => m.category === category).map((m) => ({ value: m.id, text: m.name })) });
		return [...CATEGORIES, null].map(groupOf).filter((g) => g.options.length);
	}
	const byLabel = new Map<string, Group>();
	for (const t of props.testTypes) {
		const { group: label, name } = splitTestType(t.name);
		const group = byLabel.get(label) ?? { label, options: [] };
		group.options.push({ value: t.value, text: name });
		byLabel.set(label, group);
	}
	const rank = (g: Group) => (TEST_GROUPS.includes(g.label) ? TEST_GROUPS.indexOf(g.label) : TEST_GROUPS.length - 1.5);
	return [...byLabel.values()].sort((a, b) => rank(a) - rank(b));
});

function pick(e: Event): void {
	const value = (e.target as HTMLSelectElement).value;
	if (!value) return;
	if (props.kind === 'test') emit('choose', { testType: value });
	else emit('choose', { methodId: value, category: props.methods.find((m) => m.id === value)?.category ?? null });
}
</script>

<template>
	<select class="kind nodrag nopan" data-kind-select :aria-label="kind === 'test' ? 'Type of test' : 'Kind of operation'" :value="value ?? ''" @change="pick" @dblclick.stop>
		<option value="" :selected="!value">Choose the kind…</option>
		<optgroup v-for="g in groups" :key="g.label" :label="g.label">
			<option v-for="o in g.options" :key="o.value" :value="o.value" :selected="o.value === value">{{ o.text }}</option>
		</optgroup>
	</select>
</template>

<style scoped>
.kind {
	box-sizing: border-box; width: calc(100% - 24px); margin: 8px 12px 0; padding: 4px 6px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-sm, 12px);
}
.kind:hover, .kind:focus-visible { border-color: var(--d1-accent, var(--theme--primary)); outline: none; }
</style>
