<script setup lang="ts">
import { ref, resolveComponent, watch } from 'vue';
import { useExplorerHost, type HostField } from '../host';
import { formFields } from '../editDrawer';
import { useEditSession } from '../composables/useEditSession';
import { dataStudioRoute } from '../recordRoute';
import { errorText } from '../format';
import { useRequestGate } from '../composables/useRequestGate';

// Edit a record from its page without leaving it: a drawer with the collection's own Directus form
// (v-form), so the custom interfaces (sample code, machine picker, material and project inherit,
// geometry preview ...) work unchanged. The record is read and PATCHed through /items as the
// signed-in user; only the changed fields are sent.
//
// v-form is available to module extensions (checked against the Directus source: components/register.ts
// registers VForm and VDrawer globally). If it is ever missing, the drawer does not open and the
// page goes to the Data Studio form instead (through the host). The field definitions come from the host.
const props = defineProps<{
	modelValue: boolean;
	collection: string;
	primaryKey: string;
	title?: string;
	/** Fields left out of the form because the page shows them itself. */
	hiddenFields?: string[];
}>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'saved'): void }>();

const host = useExplorerHost();
const api = host.api;
const gate = useRequestGate();

const formAvailable = typeof resolveComponent('v-form') !== 'string';

const item = ref<Record<string, any> | null>(null);
const edits = ref<Record<string, any>>({});
const loading = ref(false);
const loadError = ref('');

// The form fields, from the host (the Directus app's fields store, or GET /fields), filled by load().
const fields = ref<HostField[]>([]);

const endpoint = () => `/items/${props.collection}/${encodeURIComponent(props.primaryKey)}`;

function close() {
	emit('update:modelValue', false);
}

// Save, the version check against someone else's save, and Cancel/Discard: shared with the edit frame.
const { saving, saveError, conflict, confirmDiscard, hasEdits, reset, save, cancel, discard } = useEditSession({
	api,
	collection: () => props.collection,
	endpoint,
	item,
	edits,
	onSaved: () => {
		emit('saved');
		close();
	},
	onCancelled: close,
});

async function load() {
	const token = gate.begin();
	item.value = null;
	fields.value = [];
	edits.value = {};
	loadError.value = '';
	reset();
	loading.value = true;
	try {
		const res = await api.get(endpoint(), { params: { fields: ['*'] } });
		if (!gate.isCurrent(token)) return;
		const loaded = res.data.data;
		const defs = await host.fieldsFor(props.collection);
		if (!gate.isCurrent(token)) return;
		item.value = loaded;
		fields.value = formFields(defs, loaded, props.hiddenFields);
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
			host.openDataStudio(dataStudioRoute(props.collection, props.primaryKey));
			return;
		}
		load();
	},
	{ immediate: true },
);
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
