<script setup lang="ts">
import { computed, ref } from 'vue';
import Section from '../components/Section.vue';
import FieldInput from './FieldInput.vue';
import { hasShown, isEmptyValue } from './fieldModel';
import { inputProblem, inputText } from './inputValue';
import type { FieldView, FormField, FormNode } from './fieldModel';
import type { Values } from './conditions';

// One node of the generated form: a group (a Section at the top, a quiet sub-heading inside another group) or a
// field row (label, required mark, input, note). Recursive over its children. Everything it needs comes from
// FieldForm; it only draws, and reports edits.
const props = defineProps<{
	node: FormNode;
	views: ReadonlyMap<string, FieldView>;
	/** What the person has entered. */
	own: Values;
	/** What the record would inherit where `own` is empty. */
	inherited?: Values;
	readonly?: boolean;
	/** Every required field that is empty is marked, not only the ones the person has been into. */
	showMissing?: boolean;
	/** Fields to mark as still to fill in (the row gets class `flag`): what a caller's own checks say is missing. */
	flagged?: ReadonlySet<string>;
	touched: ReadonlySet<string>;
	idPrefix: string;
	level: number;
}>();
const emit = defineEmits<{
	(e: 'change', field: FormField, value: unknown): void;
	(e: 'touch', field: FormField): void;
	(e: 'openExternal', field: FormField): void;
}>();

const field = computed(() => props.node.field);
const view = computed(() => props.views.get(field.value.field));
const isGroup = computed(() => field.value.kind === 'group');
const visible = computed(() => !view.value?.hidden && hasShown(props.node, props.views));
const ownValue = computed(() => props.own[field.value.field]);
const inheritedValue = computed(() => props.inherited?.[field.value.field]);
const isInherited = computed(() => isEmptyValue(ownValue.value) && !isEmptyValue(inheritedValue.value));
const value = computed(() => (isInherited.value ? inheritedValue.value : ownValue.value));
const disabled = computed(() => !!props.readonly || !!view.value?.readonly);
const missing = computed(() => !!view.value?.required && isEmptyValue(value.value) && (!!props.showMissing || props.touched.has(field.value.field)));
const inputId = computed(() => `${props.idPrefix}-${field.value.field}`);
// One message element per field, always in the page (a live region that is inserted together with its text is often not
// announced): it says "Required." or what is wrong with a typed number, and is empty otherwise. The input points at it
// (and at the note) with aria-describedby.
const noteId = computed(() => `${inputId.value}-note`);
const msgId = computed(() => `${inputId.value}-msg`);
const typedProblem = ref<string | null>(null);
const problem = computed(() => typedProblem.value ?? (field.value.kind === 'number' ? inputProblem(field.value, inputText(field.value, value.value)) : null));
const flag = computed(() => !!props.flagged?.has(field.value.field));
const message = computed(() => (missing.value ? 'Required.' : (problem.value ?? (flag.value ? 'Missing.' : ''))));
const describedby = computed(() => (field.value.note ? `${noteId.value} ${msgId.value}` : msgId.value));
const full = computed(() => field.value.width === 'full' || field.value.kind === 'textarea' || field.value.kind === 'radio');
</script>

<template>
	<template v-if="visible">
		<Section v-if="isGroup && level === 0" :title="field.label" :id="`${idPrefix}-${field.field}`" collapsible :collapsed="field.collapsed">
			<div class="grid">
				<FormNodeView
					v-for="child in node.children"
					:key="child.field.field"
					:node="child"
					:views="views"
					:own="own"
					:inherited="inherited"
					:readonly="readonly"
					:show-missing="showMissing"
					:flagged="flagged"
					:touched="touched"
					:id-prefix="idPrefix"
					:level="level + 1"
					@change="(f, v) => emit('change', f, v)"
					@touch="emit('touch', $event)"
					@open-external="emit('openExternal', $event)"
				/>
			</div>
		</Section>
		<div v-else-if="isGroup" class="sub" :data-group="field.field">
			<h3>{{ field.label }}</h3>
			<div class="grid">
				<FormNodeView
					v-for="child in node.children"
					:key="child.field.field"
					:node="child"
					:views="views"
					:own="own"
					:inherited="inherited"
					:readonly="readonly"
					:show-missing="showMissing"
					:flagged="flagged"
					:touched="touched"
					:id-prefix="idPrefix"
					:level="level + 1"
					@change="(f, v) => emit('change', f, v)"
					@touch="emit('touch', $event)"
					@open-external="emit('openExternal', $event)"
				/>
			</div>
		</div>
		<div v-else class="row" :class="{ full, inherited: isInherited, missing, flag }" :data-field="field.field">
			<label :for="field.kind === 'external' ? undefined : inputId" class="lab">
				<span>{{ field.label }}</span>
				<abbr v-if="view?.required || flag" class="req" :title="view?.required ? 'Required' : 'Missing'" :aria-label="view?.required ? 'required' : 'missing'">*</abbr>
				<span v-if="isInherited" class="tag" title="Taken from the record this belongs to; type to use another value.">inherited</span>
			</label>
			<FieldInput
				:field="field"
				:value="value"
				:id="inputId"
				:disabled="disabled"
				:inherited="isInherited"
				:options="view?.options"
				:required="view?.required"
				:invalid="missing"
				:describedby="describedby"
				@update:value="emit('change', field, $event)"
				@problem="typedProblem = $event"
				@blur="emit('touch', field)"
				@open-external="emit('openExternal', field)"
			/>
			<p v-if="field.note" :id="noteId" class="note">{{ field.note }}</p>
			<p :id="msgId" class="miss" role="status" aria-live="polite">{{ message }}</p>
		</div>
	</template>
</template>

<style scoped>
/* Two columns when there is room (a half-width field takes one), one in a narrow rail. */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(max(220px, 45%), 1fr)); gap: 12px 16px; align-items: start; min-width: 0; }
.row { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.row.full, .sub { grid-column: 1 / -1; }
.lab { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm, 12px); font-weight: 650; }
.req { color: var(--d1-bad); text-decoration: none; font-weight: 700; }
.tag { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); border: 1px solid var(--d1-line); border-radius: 99px; padding: 0 6px; }
.note { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.miss { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-bad); }
.miss:empty { display: none; }
.row.missing :deep(.ctl), .row.missing :deep(.sel), .row.missing :deep(.q) { border-color: var(--d1-bad); }
.sub { min-width: 0; padding-top: 4px; border-top: 1px solid var(--d1-line); }
.sub h3 { margin: 6px 0 8px; font-size: var(--fs-sm, 12px); font-weight: 650; letter-spacing: 0.01em; color: var(--d1-dim); }
</style>
