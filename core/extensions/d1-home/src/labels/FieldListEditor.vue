<script setup lang="ts">
import { computed } from 'vue';
import { FIELD_KEYS, FIELD_SIZES, moveField, type FieldKey, type FieldSize, type LabelField } from '@d1/ui';
import './form.css';

// The ordered list of printed lines of a template (add, remove, reorder, size, bold) and the extra
// fields that go into the QR payload. The code and short id are always in the payload, so only the
// others are offered there.
const props = defineProps<{ fields: LabelField[]; qrFields: FieldKey[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:fields': [LabelField[]]; 'update:qrFields': [FieldKey[]] }>();

const KEY_LABEL: Record<FieldKey, string> = {
	sample_code: 'Sample code', short_id: 'Short ID', nickname: 'Nickname', material: 'Material', date: 'Date', owner_initials: 'Owner initials',
};
const SIZE_LABEL: Record<FieldSize, string> = { lg: 'Large', md: 'Normal', sm: 'Small' };
const QR_EXTRAS: FieldKey[] = ['nickname', 'material', 'date', 'owner_initials'];

const unused = computed(() => FIELD_KEYS.filter((k) => !props.fields.some((f) => f.key === k)));

const setField = (i: number, patch: Partial<LabelField>) =>
	emit('update:fields', props.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
const move = (i: number, to: number) => emit('update:fields', moveField(props.fields, i, to));
const removeAt = (i: number) => emit('update:fields', props.fields.filter((_, j) => j !== i));
const add = (key: FieldKey) => emit('update:fields', [...props.fields, { key, size: 'md', bold: false }]);
const toggleQr = (key: FieldKey, on: boolean) =>
	emit('update:qrFields', on ? [...props.qrFields.filter((k) => k !== key), key] : props.qrFields.filter((k) => k !== key));
</script>

<template>
	<div class="fields">
		<p class="cap">Printed lines, top to bottom</p>
		<p v-if="!fields.length" class="d1-note">No lines. The label shows the QR code only.</p>
		<ol class="list">
			<li v-for="(f, i) in fields" :key="f.key" class="line">
				<select class="lf-input" :value="f.key" :disabled="disabled" :aria-label="`Field ${i + 1}`" @change="setField(i, { key: ($event.target as HTMLSelectElement).value as FieldKey })">
					<option v-for="k in FIELD_KEYS" :key="k" :value="k" :disabled="k !== f.key && fields.some((x) => x.key === k)">{{ KEY_LABEL[k] }}</option>
				</select>
				<select class="lf-input" :value="f.size" :disabled="disabled" :aria-label="`Size of ${KEY_LABEL[f.key]}`" @change="setField(i, { size: ($event.target as HTMLSelectElement).value as FieldSize })">
					<option v-for="s in FIELD_SIZES" :key="s" :value="s">{{ SIZE_LABEL[s] }}</option>
				</select>
				<label class="lf-check"><input type="checkbox" :checked="f.bold" :disabled="disabled" @change="setField(i, { bold: ($event.target as HTMLInputElement).checked })" />Bold</label>
				<span class="spacer" />
				<button type="button" class="lf-btn icon" :disabled="disabled || i === 0" :aria-label="`Move ${KEY_LABEL[f.key]} up`" @click="move(i, i - 1)">↑</button>
				<button type="button" class="lf-btn icon" :disabled="disabled || i === fields.length - 1" :aria-label="`Move ${KEY_LABEL[f.key]} down`" @click="move(i, i + 1)">↓</button>
				<button type="button" class="lf-btn icon bad" :disabled="disabled" :aria-label="`Remove ${KEY_LABEL[f.key]}`" @click="removeAt(i)">×</button>
			</li>
		</ol>
		<div v-if="unused.length" class="lf-row add">
			<span class="d1-note">Add</span>
			<button v-for="k in unused" :key="k" type="button" class="lf-btn" :disabled="disabled" @click="add(k)">+ {{ KEY_LABEL[k] }}</button>
		</div>

		<p class="cap">Also in the QR code</p>
		<div class="lf-row qr">
			<label v-for="k in QR_EXTRAS" :key="k" class="lf-check">
				<input type="checkbox" :checked="qrFields.includes(k)" :disabled="disabled" @change="toggleQr(k, ($event.target as HTMLInputElement).checked)" />{{ KEY_LABEL[k] }}
			</label>
		</div>
		<p class="d1-note">The sample code and short ID are always in the QR code.</p>
	</div>
</template>

<style scoped>
.fields { display: flex; flex-direction: column; gap: 8px; }
.cap { margin: 4px 0 0; font-size: var(--fs-xs, 11px); font-weight: 650; color: var(--d1-dim); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spacer { flex: 1; }
.add { align-items: center; }
.qr { gap: 16px; align-items: center; }
</style>
