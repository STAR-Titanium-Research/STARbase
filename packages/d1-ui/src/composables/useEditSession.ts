import { computed, ref, type Ref } from 'vue';
import { buildPatch, saveErrors, versionChanged } from '../editDrawer';

// The save, version-conflict and discard rules of an edit form, shared by EditDrawer (the Explorer pages)
// and the edit frame (core/extensions/d1-edit-frame): only changed fields are sent, the OCC `version` is
// re-read before saving, a refusal says why, and Cancel asks before throwing edits away. The caller owns
// the form state (`item`, `edits`) and what happens next (`onSaved`, `onCancelled`).

// Axios-shaped, like HostApi (Directus's api client, STARbase's client).
export interface EditSessionApi {
	get(path: string, config?: any): Promise<{ data?: any }>;
	patch(path: string, body?: unknown): Promise<unknown>;
	post(path: string, body?: unknown): Promise<{ data?: any }>;
}

export interface EditSessionOptions {
	api: EditSessionApi;
	collection: () => string;
	/** /items/<collection>/<id>: where the record is read and PATCHed. */
	endpoint: () => string;
	item: Ref<Record<string, any> | null>;
	/** The form's v-model: the changed fields only. */
	edits: Ref<Record<string, any>>;
	/** A new record: Save POSTs to /items/<collection> (even an empty form) and there is no version to check. */
	creating?: () => boolean;
	/** After a successful save; for a new record, the created row. */
	onSaved: (created?: any) => void;
	/** After Cancel (nothing to lose) or Discard. */
	onCancelled: () => void;
}

export function useEditSession(opts: EditSessionOptions) {
	const saving = ref(false);
	const saveError = ref<string[]>([]);
	// Set when the record's version moved between opening the form and pressing Save.
	const conflict = ref<{ loaded: number; current: number } | null>(null);
	const confirmDiscard = ref(false);
	const hasEdits = computed(() => buildPatch(opts.edits.value) !== null);

	// For a (re)load: forget the last refusal and conflict.
	function reset() {
		saveError.value = [];
		conflict.value = null;
	}

	async function save(overwrite = false) {
		const creating = opts.creating?.() ?? false;
		const patch = buildPatch(opts.edits.value);
		if (saving.value || (!patch && !creating)) return;
		saving.value = true;
		saveError.value = [];
		try {
			if (creating) {
				const res = await opts.api.post(`/items/${opts.collection()}`, patch ?? {});
				opts.onSaved(res?.data?.data);
				return;
			}
			// Re-read the version first: occ_update_trigger_function() bumps it on every update, so a
			// different number means someone else saved while this form was open.
			const item = opts.item.value;
			if (!overwrite && item && 'version' in item) {
				const res = await opts.api.get(opts.endpoint(), { params: { fields: ['version'] } });
				const current = res.data?.data?.version;
				if (versionChanged(item.version, current)) {
					conflict.value = { loaded: Number(item.version), current: Number(current) };
					return;
				}
			}
			conflict.value = null;
			await opts.api.patch(opts.endpoint(), patch);
			opts.onSaved();
		} catch (e) {
			saveError.value = saveErrors(e, opts.collection());
		} finally {
			saving.value = false;
		}
	}

	function cancel() {
		if (hasEdits.value) confirmDiscard.value = true;
		else opts.onCancelled();
	}

	function discard() {
		confirmDiscard.value = false;
		opts.onCancelled();
	}

	return { saving, saveError, conflict, confirmDiscard, hasEdits, reset, save, cancel, discard };
}
