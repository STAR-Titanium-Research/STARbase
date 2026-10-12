import { ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { errorText, saveErrorText, templatePayload, type LabelTemplate } from '@d1/ui';

// Save, Save as new and Delete of the template editor, as the signed-in user (Directus decides what they may
// do; the editor only hides what the server would refuse). `error` is the inline message of the last failure.
export function useTemplateSave() {
	const api = useApi();
	const busy = ref(false);
	const error = ref('');

	// At most one template is the default (a partial unique index), so an admin making one the default
	// first clears the old one.
	async function clearDefault(templates: LabelTemplate[], exceptId: string | null): Promise<void> {
		for (const t of templates) {
			if (t.isDefault && t.id && t.id !== exceptId) await api.patch(`/items/label_templates/${t.id}`, { is_default: false });
		}
	}

	async function run<T>(job: () => Promise<T>): Promise<T | null> {
		busy.value = true;
		error.value = '';
		try {
			return await job();
		} catch (e) {
			error.value = saveErrorText(errorText(e, 'The template could not be saved.'));
			return null;
		} finally {
			busy.value = false;
		}
	}

	// Returns the id of the saved template, or null (see `error`).
	const create = (draft: LabelTemplate, isAdmin: boolean, all: LabelTemplate[]) =>
		run(async () => {
			if (isAdmin && draft.isDefault) await clearDefault(all, null);
			const res = await api.post('/items/label_templates', templatePayload(draft, isAdmin));
			return res.data?.data?.id as string;
		});

	const update = (draft: LabelTemplate, isAdmin: boolean, all: LabelTemplate[]) =>
		run(async () => {
			if (!draft.id) throw new Error('This template has not been saved yet.');
			if (isAdmin && draft.isDefault) await clearDefault(all, draft.id);
			await api.patch(`/items/label_templates/${draft.id}`, templatePayload(draft, isAdmin));
			return draft.id;
		});

	const remove = (id: string) =>
		run(async () => {
			await api.delete(`/items/label_templates/${id}`);
			return true;
		});

	return { busy, error, create, update, remove };
}
