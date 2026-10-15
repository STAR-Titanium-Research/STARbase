import { ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { InboxApiError, loadAdmin, scanAll, type InboxAdmin } from './inboxApi';
import { SCAN_ALL_TEXT } from './adminView';

// The Inbox crawler tab's state: GET /d1-inbox/admin (administrators only) and the Scan all button. No lifecycle hooks (the panel adds the
// poll), so it is tested with the fake server. A failed refresh keeps what was shown, with the reason; a 404 says the server has no d1-inbox
// yet (final: it stops asking), a 403 says the tab is for administrators (not final: the next poll asks again, a role can change), and anything
// else, a 401 included, is an error line.

export type Missing = 'none' | 'no-endpoint' | 'not-admin';

export function createInboxAdmin(api: HostApi) {
	const gate = useRequestGate();
	const data = ref<InboxAdmin | null>(null);
	const loading = ref(true);
	const error = ref('');
	const missing = ref<Missing>('none');
	const scanning = ref(false);
	const note = ref('');
	const actionError = ref('');
	let busy = false;

	async function load(): Promise<void> {
		if (busy || missing.value === 'no-endpoint') return;
		busy = true;
		const token = gate.begin();
		try {
			const next = await loadAdmin(api);
			if (!gate.isCurrent(token)) return;
			data.value = next;
			error.value = '';
			missing.value = 'none';
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			if (e instanceof InboxApiError && e.status === 404) missing.value = 'no-endpoint';
			else if (e instanceof InboxApiError && e.status === 403) missing.value = 'not-admin';
			else error.value = `Could not refresh the Inbox crawler status: ${e instanceof Error ? e.message : 'request failed'}`;
		} finally {
			busy = false;
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	async function scanAllNow(): Promise<boolean> {
		scanning.value = true;
		actionError.value = '';
		note.value = '';
		try {
			await scanAll(api);
			note.value = SCAN_ALL_TEXT;
			await load();
			return true;
		} catch (e) {
			actionError.value = e instanceof Error ? e.message : 'Could not ask for the scan.';
			return false;
		} finally {
			scanning.value = false;
		}
	}

	return { data, loading, error, missing, scanning, note, actionError, load, scanAllNow, cancel: () => gate.cancel() };
}
