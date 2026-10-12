import { ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { saveErrorText, templatePayload, type LabelTemplate } from '@d1/ui';

// Save, Save as new and Delete of the template editor, as the signed-in user (Directus decides what they may
// do; the editor only hides what the server would refuse). `error` is the inline message of the last failure.
// Making a template the default is one write: a database trigger clears the previous default.
export function useTemplateSave() {
	const api = useApi();
	const busy = ref(false);
	const error = ref('');

	async function run<T>(job: () => Promise<T>): Promise<T | null> {
		busy.value = true;
		error.value = '';
		try {
			return await job();
		} catch (e) {
			error.value = saveErrorText(e);
			return null;
		} finally {
			busy.value = false;
		}
	}

	// Returns the id of the saved template, or null (see `error`).
	const create = (draft: LabelTemplate, isAdmin: boolean) =>
		run(async () => {
			const res = await api.post('/items/label_templates', templatePayload(draft, isAdmin));
			return res.data?.data?.id as string;
		});

	const update = (draft: LabelTemplate, isAdmin: boolean) =>
		run(async () => {
			if (!draft.id) throw new Error('This template has not been saved yet.');
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
