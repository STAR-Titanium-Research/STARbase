<script setup lang="ts">
// Machine + Operator + Operation type, together in one subpanel: this is "who/what/which kind of
// cut", the identity-adjacent facts that get set once and mostly left alone for a session, as
// opposed to Insert/Edge/Tool (Tooling) which turn over every cut. Machine + Operator change least
// often of the three (same machine + operator for most of a session's cuts), so they share the
// top compact row; Operation type gets its own row below since its options are long text, not a
// short search-box value.
import { useWorkspace } from '../workspace';
import LookupField from './LookupField.vue';

const w = useWorkspace();

const MACHINING_SUBTYPES = [
	{ value: 'MT-F', text: 'Turning – Facing' },
	{ value: 'MT-R', text: 'Turning – Roughing' },
	{ value: 'MT-O', text: 'Turning – OD' },
	{ value: 'MT-G', text: 'Turning – Grooving' },
	{ value: 'MT-B', text: 'Turning – Boring' },
	{ value: 'MT-H', text: 'Turning – Threading' },
	{ value: 'MT-P', text: 'Turning – Parting' },
	{ value: 'MT-D', text: 'Turning – Drilling' },
	{ value: 'MM-F', text: 'Milling – Facing' },
	{ value: 'MM-R', text: 'Milling – Roughing' },
	{ value: 'MM-S', text: 'Milling – Slotting' },
	{ value: 'MM-D', text: 'Milling – Drilling' },
	{ value: 'other', text: 'Other' },
] as const;
</script>

<template>
	<div class="machine-op">
		<div class="row2">
			<LookupField v-model="w.link.equipmentId" :display-label="w.link.equipmentLabel" label="Machine" placeholder="machine…"
				icon="precision_manufacturing" :search="w.searchEquipmentForOp" :disabled="w.locked.value"
				@select="(i: any) => (w.link.equipmentLabel = i.label)" />
			<LookupField v-model="w.link.operatorId" :display-label="w.link.operatorLabel" label="Operator" placeholder="operator…"
				icon="person" :search="w.searchOperators" :disabled="w.locked.value"
				@select="(i: any) => (w.link.operatorLabel = i.label)" />
		</div>
		<label class="op-type">Operation type
			<select v-model="w.meta.op_type" :disabled="w.locked.value">
				<option value="">—</option>
				<option v-for="t in MACHINING_SUBTYPES" :key="t.value" :value="t.value">{{ t.text }}</option>
			</select>
		</label>
	</div>
</template>

<style scoped>
.machine-op { margin-bottom: 12px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.row2 :deep(.lookup) { margin-bottom: 8px; min-width: 0; }
.op-type { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin: 0; }
.op-type select { display: block; width: 100%; margin-top: 3px; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; outline: none; font-family: inherit; }
.op-type select:focus { border-color: var(--accent); }
.op-type select:disabled { opacity: 0.55; }
.op-type select option { background: var(--bg); color: var(--text); }
</style>
