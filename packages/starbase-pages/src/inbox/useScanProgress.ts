import { ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { InboxApiError, loadProgress, type ProgressFolder } from './inboxApi';

// The scan progress of the folders, read from GET /d1-inbox/progress: the person's own (the Inbox page's card) or every folder (all: true, the admin tab). No
// lifecycle hooks, so it is tested with the fake server. A failed refresh keeps what was shown, with the reason. `loaded` says an answer has come, so a page can
// tell "nothing yet" from "no folder". A server with no such route (404) or a refusal (403) is just "no progress to show".
export function createScanProgress(api: HostApi, opts: { all?: boolean } = {}) {
	const gate = useRequestGate();
	const folders = ref<ProgressFolder[]>([]);
	const lastScanFinishedAt = ref<string | null>(null);
	const loading = ref(true);
	const loaded = ref(false);
	const error = ref('');
	let busy = false;

	async function load(): Promise<void> {
		if (busy) return;
		busy = true;
		const token = gate.begin();
		try {
			const next = await loadProgress(api, opts);
			if (!gate.isCurrent(token)) return;
			folders.value = next.folders;
			lastScanFinishedAt.value = next.last_scan_finished_at;
			error.value = '';
			loaded.value = true;
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			if (e instanceof InboxApiError && (e.status === 404 || e.status === 403)) {
				folders.value = [];
				loaded.value = true;
				error.value = '';
			} else error.value = `Could not read the scan progress: ${e instanceof Error ? e.message : 'request failed'}`;
		} finally {
			busy = false;
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	return { folders, lastScanFinishedAt, loading, loaded, error, load, cancel: () => gate.cancel() };
}
