import { ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { InboxApiError, loadFiles, loadPrefs, savePrefs, undoBatch, type FoundFile } from './inboxApi';
import { undoResultText } from './inboxBulk';

// The Settings section for automatic linking (decision D10): the per-person switch (off by default) and the "Recently auto-linked" list,
// with its undo. No lifecycle hooks, so it is tested with the fake server (AutoLinkSection adds them).
//
// A server without d1-inbox (404) leaves the section out (`absent`): Settings must work before the server side is
// deployed. A refusal (403, 401) is an error line with Retry, as it may pass. A failed save puts the switch back and says so, with Retry.

export const RECENT_LIMIT = 20;

export function createAutoLink(api: HostApi, onChanged?: () => void) {
	const gate = useRequestGate();
	const on = ref(false);
	const loading = ref(true);
	const absent = ref(false);
	const saving = ref(false);
	const error = ref('');
	const note = ref('');
	const recent = ref<FoundFile[]>([]);
	const recentError = ref('');
	const undoing = ref<string | null>(null);

	const missing = (e: unknown) => e instanceof InboxApiError && e.status === 404;

	async function loadRecent(): Promise<void> {
		const token = gate.begin();
		try {
			const page = await loadFiles(api, { tab: 'linked', link_kind: 'auto', limit: RECENT_LIMIT });
			if (!gate.isCurrent(token)) return;
			recent.value = page.rows;
			recentError.value = '';
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			// A failed reload keeps the list that was shown.
			recentError.value = e instanceof Error ? e.message : 'Could not load the list.';
		}
	}

	async function load(): Promise<void> {
		loading.value = true;
		try {
			on.value = (await loadPrefs(api)).auto_link;
			absent.value = false;
			error.value = '';
			await loadRecent();
		} catch (e) {
			if (missing(e)) absent.value = true;
			else error.value = e instanceof Error ? e.message : 'Could not read your setting.';
		} finally {
			loading.value = false;
		}
	}

	/** Turn it on or off. Returns whether it saved; on a failure the switch is back where it was, with the reason in `error`. */
	async function set(next: boolean): Promise<boolean> {
		saving.value = true;
		error.value = '';
		note.value = '';
		const before = on.value;
		on.value = next;
		try {
			on.value = (await savePrefs(api, { auto_link: next })).auto_link;
			note.value = on.value ? 'Saved. New pictures that name one of your records by short ID will be linked for you.' : 'Saved. Automatic linking is off.';
			return true;
		} catch (e) {
			on.value = before;
			error.value = e instanceof Error ? e.message : 'Could not save.';
			return false;
		} finally {
			saving.value = false;
		}
	}

	async function undo(batchId: string): Promise<void> {
		undoing.value = batchId;
		error.value = '';
		try {
			const n = await undoBatch(api, batchId);
			note.value = undoResultText(n);
			await loadRecent();
			onChanged?.();
		} catch (e) {
			error.value = e instanceof Error ? e.message : 'Could not undo that.';
		} finally {
			undoing.value = null;
		}
	}

	return { on, loading, absent, saving, error, note, recent, recentError, undoing, load, set, undo, loadRecent, cancel: () => gate.cancel() };
}
