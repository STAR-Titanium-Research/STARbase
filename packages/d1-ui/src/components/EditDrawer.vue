<script setup lang="ts">
import { computed, ref, resolveComponent, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useApi, useStores } from '@directus/extensions-sdk';
import { buildPatch, formFields, saveErrors, versionChanged, type FieldDef } from '../editDrawer';
import { dataStudioRoute } from '../recordRoute';
import { errorText } from '../format';
import { useRequestGate } from '../composables/useRequestGate';

// Edit a record from its page without leaving it: a drawer with the collection's own Directus form
// (v-form), so the custom interfaces (sample code, machine picker, material and project inherit,
// geometry preview ...) work unchanged. The record is read and PATCHed through /items as the
// signed-in user; only the changed fields are sent.
//
// Both v-form and the fields store are available to module extensions (checked against the
// Directus source: components/register.ts registers VForm and VDrawer globally, and useSystem()
// provides useFieldsStore through useStores()). If either is ever missing, the drawer does not
// open and the page goes to the Data Studio form instead.
const props = defineProps<{
	modelValue: boolean;
	collection: string;
	primaryKey: string;
	title?: string;
	/** Fields left out of the form because the page shows them itself. */
	hiddenFields?: string[];
}>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'saved'): void }>();

const api = useApi();
const router = useRouter();
const stores = useStores();
const gate = useRequestGate();

const formAvailable = typeof resolveComponent('v-form') !== 'string' && typeof stores.useFieldsStore === 'function';

const item = ref<Record<string, any> | null>(null);
const edits = ref<Record<string, any>>({});
const loading = ref(false);
const loadError = ref('');
const saving = ref(false);
const saveError = ref<string[]>([]);
// Set when the record's version moved between opening the drawer and pressing Save.
const conflict = ref<{ loaded: number; current: number } | null>(null);
const confirmDiscard = ref(false);

const fields = computed<FieldDef[]>(() => {
	if (!formAvailable) return [];
	const all = stores.useFieldsStore().getFieldsForCollectionSorted(props.collection) as FieldDef[];
	return formFields(all, item.value, props.hiddenFields);
});
const hasEdits = computed(() => buildPatch(edits.value) !== null);

const endpoint = () => `/items/${props.collection}/${encodeURIComponent(props.primaryKey)}`;

async function load() {
	const token = gate.begin();
	item.value = null;
	edits.value = {};
	loadError.value = '';
	saveError.value = [];
	conflict.value = null;
	loading.value = true;
	try {
		const res = await api.get(endpoint(), { params: { fields: ['*'] } });
		if (!gate.isCurrent(token)) return;
		item.value = res.data.data;
	} catch (e) {
		if (gate.isCurrent(token)) loadError.value = `Could not load the record: ${errorText(e)}`;
	} finally {
		if (gate.isCurrent(token)) loading.value = false;
	}
}

watch(
	() => [props.modelValue, props.collection, props.primaryKey],
	() => {
		if (!props.modelValue) {
			gate.cancel();
			return;
		}
		if (!formAvailable) {
			emit('update:modelValue', false);
			router.push(dataStudioRoute(props.collection, props.primaryKey));
			return;
		}
		load();
	},
	{ immediate: true },
);

function close() {
	emit('update:modelValue', false);
}

function cancel() {
	if (hasEdits.value) confirmDiscard.value = true;
	else close();
}

function discard() {
	confirmDiscard.value = false;
	close();
}

async function save(overwrite = false) {
	const patch = buildPatch(edits.value);
	if (!patch || saving.value) return;
	saving.value = true;
	saveError.value = [];
	try {
		// Re-read the version first: occ_update_trigger_function() bumps it on every update, so a
		// different number means someone else saved while this drawer was open.
		if (!overwrite && item.value && 'version' in item.value) {
			const res = await api.get(endpoint(), { params: { fields: ['version'] } });
			const current = res.data.data?.version;
			if (versionChanged(item.value.version, current)) {
				conflict.value = { loaded: Number(item.value.version), current: Number(current) };
				return;
			}
		}
		conflict.value = null;
		await api.patch(endpoint(), patch);
		emit('saved');
		close();
	} catch (e) {
		saveError.value = saveErrors(e);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-drawer
		v-if="formAvailable"
		:model-value="modelValue"
		:title="title ?? 'Edit'"
		icon="edit"
		persistent
		@update:model-value="emit('update:modelValue', $event)"
		@cancel="cancel"
		@apply="save()"
	>
		<template #actions>
			<v-button v-tooltip.bottom="'Save'" icon rounded :loading="saving" :disabled="!hasEdits" @click="save()">
				<v-icon name="check" />
			</v-button>
		</template>

		<div class="d1-edit-drawer">
			<v-notice v-if="loadError" type="danger">{{ loadError }}</v-notice>
			<v-progress-linear v-else-if="loading" indeterminate />
			<template v-else-if="item">
				<v-notice v-if="conflict" type="warning" class="notice">
					<div class="conflict">
						<span>
							Someone else saved this record while you were editing (version {{ conflict.loaded }} is now
							{{ conflict.current }}). Saving now would overwrite their changes.
						</span>
						<span class="conflict-actions">
							<v-button small secondary @click="load()">Discard mine and reload</v-button>
							<v-button small @click="save(true)">Save anyway</v-button>
						</span>
					</div>
				</v-notice>
				<v-notice v-for="msg in saveError" :key="msg" type="danger" class="notice">{{ msg }}</v-notice>

				<v-form
					v-model="edits"
					:fields="fields"
					:initial-values="item"
					:primary-key="primaryKey"
					:disabled="saving"
				/>
			</template>
		</div>

		<v-dialog v-model="confirmDiscard" @esc="confirmDiscard = false">
			<v-card>
				<v-card-title>Discard your changes?</v-card-title>
				<v-card-text>The edits you made to this record have not been saved.</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmDiscard = false">Keep editing</v-button>
					<v-button kind="danger" @click="discard">Discard</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-drawer>
</template>

<style scoped>
.d1-edit-drawer {
	padding: 0 var(--content-padding, 32px) var(--content-padding-bottom, 132px);
}
.notice { margin-bottom: 16px; }
.conflict { display: flex; flex-direction: column; gap: 10px; }
.conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
