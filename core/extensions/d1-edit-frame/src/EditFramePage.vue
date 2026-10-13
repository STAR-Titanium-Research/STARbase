<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
// Subpath imports: the pure helpers only, not the kit's Vue components.
import { createFormFields, formFields, type FieldDef } from '@d1/ui/editDrawer';
import { frameReporter, loadTargetOrigin, NEW_ITEM_ID } from '@d1/ui/editFrame';
import { useEditSession } from '@d1/ui/editSession';

// One record in Directus's own form (v-form: every custom interface works), with Save and Cancel and
// nothing else, for STARbase to frame. The save, version-conflict and discard rules are the kit's
// (useEditSession, the same ones EditDrawer uses): only changed fields are PATCHed, the OCC version is
// re-read before saving, and a refusal says why.
const props = defineProps<{ collection: string; id: string }>();

const api = useApi();
const fieldsStore = useStores().useFieldsStore();
// STARbase's origin as d1-server knows it (GET /d1-links), set on mount; null = tell nobody.
const targetOrigin = ref<string | null>(null);
const creating = computed(() => props.id === NEW_ITEM_ID);

const item = ref<Record<string, any> | null>(null);
const fields = ref<FieldDef[]>([]);
const edits = ref<Record<string, any>>({});
const loading = ref(true);
const loadError = ref('');
const done = ref<'' | 'saved' | 'cancelled'>('');
const endpoint = () => `/items/${props.collection}/${encodeURIComponent(props.id)}`;
const primaryKeyField = computed(() => fields.value.find((f) => f.schema?.is_primary_key)?.field ?? 'id');
const framed = window.parent !== window;

// Tell STARbase: the page framing this one, or (opened as a new tab) the STARbase tab that opened it, and
// only at STARbase's origin as d1-server knows it (targetOrigin, from GET /d1-links). Without it, nothing
// is posted and this page says itself that the form can be closed.
const tell = frameReporter({ framed, parent: () => window.parent, opener: () => window.opener, targetOrigin: () => targetOrigin.value, collection: props.collection, id: () => props.id });
// After Save or Cancel: framed and told, STARbase closes the dialog; otherwise this page says what to do.
const told = ref(false);
const closeHint = computed(() => (told.value ? '' : framed ? ' You can close this form.' : ' You can close this tab.'));

function finish(result: 'saved' | 'cancelled', id = props.id) {
	done.value = result;
	told.value = tell(result, id);
	// Opened as a tab by STARbase (the fallback) and told: close it, the STARbase tab takes over.
	if (told.value && !framed && window.opener) window.close();
}

const { saving, saveError, conflict, confirmDiscard, hasEdits, reset, save, cancel, discard } = useEditSession({
	api,
	collection: () => props.collection,
	endpoint,
	item,
	edits,
	creating: () => creating.value,
	onSaved: (created) => finish('saved', creating.value ? String(created?.[primaryKeyField.value] ?? '') : props.id),
	onCancelled: () => finish('cancelled'),
});

function messageOf(e: any): string {
	return e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'unknown error';
}

async function load() {
	loading.value = true;
	loadError.value = '';
	reset();
	edits.value = {};
	try {
		const defs = fieldsStore.getFieldsForCollectionSorted(props.collection) as unknown as FieldDef[];
		if (creating.value) {
			item.value = {};
			fields.value = createFormFields(defs);
		} else {
			const res = await api.get(endpoint(), { params: { fields: ['*'] } });
			item.value = res.data.data;
			fields.value = formFields(defs, item.value);
		}
	} catch (e) {
		loadError.value = `Could not load the record: ${messageOf(e)}`;
	} finally {
		loading.value = false;
	}
}

onMounted(async () => {
	void load();
	// Who to tell: STARbase's origin from d1-server's own setting (GET /d1-links → STARBASE_URL), never from
	// this page's URL, which anyone can write. Unset, or the endpoint missing: tell nobody.
	targetOrigin.value = await loadTargetOrigin(api);
	// Rendering at all means Directus has a session here: STARbase stops waiting (its "ready" timeout).
	tell('ready');
});
</script>

<template>
	<div class="d1-edit-frame">
		<header class="bar">
			<h1>{{ creating ? 'New record' : 'Edit record' }} <small>{{ collection }}</small></h1>
			<div v-if="!done" class="actions">
				<v-button secondary :disabled="saving" @click="cancel">Cancel</v-button>
				<v-button :loading="saving" :disabled="loading || (!hasEdits && !creating)" @click="save()">Save</v-button>
			</div>
		</header>

		<main class="body">
			<v-notice v-if="done === 'saved'" type="success">Saved.{{ closeHint }}</v-notice>
			<v-notice v-else-if="done === 'cancelled'" type="info">Nothing was saved.{{ closeHint }}</v-notice>
			<v-notice v-else-if="loadError" type="danger">{{ loadError }}</v-notice>
			<v-progress-linear v-else-if="loading" indeterminate />
			<template v-else-if="item">
				<v-notice v-if="conflict" type="warning" class="notice">
					Someone else saved this record while you were editing (version {{ conflict.loaded }} is now {{ conflict.current }}).
					Saving now would overwrite their changes.
					<span class="conflict-actions">
						<v-button small secondary @click="load()">Discard mine and reload</v-button>
						<v-button small @click="save(true)">Save anyway</v-button>
					</span>
				</v-notice>
				<v-notice v-for="msg in saveError" :key="msg" type="danger" class="notice">{{ msg }}</v-notice>
				<v-form v-model="edits" :fields="fields" :initial-values="item" :primary-key="creating ? NEW_ITEM_ID : id" :disabled="saving" />
			</template>
		</main>

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
	</div>
</template>

<style scoped>
.d1-edit-frame { min-height: 100vh; background: var(--theme--background); color: var(--theme--foreground); }
.bar {
	position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 12px 24px;
	background: var(--theme--background); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.bar h1 { flex: 1 1 auto; margin: 0; font-size: 18px; }
.bar small { font-weight: 400; color: var(--theme--foreground-subdued); }
.actions { display: flex; gap: 8px; }
.body { padding: 20px 24px 64px; }
.notice { margin-bottom: 16px; }
.conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
</style>
