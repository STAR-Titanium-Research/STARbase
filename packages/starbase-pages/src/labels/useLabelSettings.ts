import { ref } from 'vue';
import { useExplorerHost, contactEmailOf, errorText, parseContactInput } from '@d1/ui';

// The label_settings singleton: the lab contact email every label's QR code carries. Everyone reads it (one
// GET, as the signed-in user); only an admin can write it (Directus refuses anyone else, so the page shows the
// edit box to admins only and a refusal still shows as the inline error). One PATCH saves it.
export function useLabelSettings() {
	const api = useExplorerHost().api;
	const contactEmail = ref<string | null>(null);
	const loaded = ref(false);
	const loadError = ref('');
	const saving = ref(false);
	const saveError = ref('');

	async function load(): Promise<void> {
		loadError.value = '';
		try {
			const res = await api.get('/items/label_settings');
			contactEmail.value = contactEmailOf(res.data?.data);
		} catch (e) {
			// The labels still print, just without the Contact line.
			loadError.value = `Could not read the lab contact: ${errorText(e)}`;
		} finally {
			loaded.value = true;
		}
	}

	// Returns true when saved. `text` is what the admin typed.
	async function save(text: string): Promise<boolean> {
		const parsed = parseContactInput(text);
		if (!parsed.ok) {
			saveError.value = parsed.error;
			return false;
		}
		saving.value = true;
		saveError.value = '';
		try {
			const res = await api.patch('/items/label_settings', { contact_email: parsed.value });
			contactEmail.value = contactEmailOf(res.data?.data) ?? parsed.value;
			return true;
		} catch (e) {
			saveError.value = `Could not save the lab contact: ${errorText(e)}`;
			return false;
		} finally {
			saving.value = false;
		}
	}

	return { contactEmail, loaded, loadError, saving, saveError, load, save };
}
