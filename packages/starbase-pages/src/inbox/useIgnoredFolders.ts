import { computed, ref } from 'vue';
import type { HostApi } from '@d1/ui';
import { InboxApiError, addIgnored, listIgnored, removeIgnored, type FoundFile, type IgnoredRule } from './inboxApi';
import { folderProblem, ignoreTarget, ignoredText, shownBelow, unignoredText, type IgnoreTarget } from './ignoredFolders';
import type { Notice, Outcome } from './useInbox';

// Ignored folders on the Inbox page (spec section 15), over the typed client with no lifecycle hooks: the rules, "Ignore this folder" on a row (a confirm
// that says what happens), the add field and Remove. Adding a rule dismisses the owner's open files below the folder on the server, in one step; the
// answer says how many, and the notice says so with a Remove rule button (nothing is restored by it: the files stay in Dismissed, where Restore is).
// After an add or a remove the lists and the counts are read again (deps.onChanged).

/** The confirm of "Ignore this folder". `shown` is how many open files below the folder are on screen: an estimate. */
export interface IgnoreDialog {
	open: boolean;
	target: IgnoreTarget | null;
	shown: number;
	busy: boolean;
	error: string;
}
const closed = (): IgnoreDialog => ({ open: false, target: null, shown: 0, busy: false, error: '' });

export interface IgnoredDeps {
	api: HostApi;
	/** The page's one status line. */
	say: (n: Notice | null) => void;
	/** The rows the page holds (for the estimate in the confirm). */
	rows: () => FoundFile[];
	/** Rules changed, and with them what the lists and the badge hold: read both again. */
	onChanged: () => Promise<void> | void;
}

const words = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function createIgnoredFolders(deps: IgnoredDeps) {
	const { api } = deps;
	const rules = ref<IgnoredRule[]>([]);
	const loading = ref(true);
	/** Why the list could not be read or a rule could not be removed (the endpoint's own words). */
	const error = ref('');
	/** False on a server with no ignored-folders route (an older d1-inbox): the page then shows nothing about it. */
	const available = ref(true);
	const open = ref(false);
	const removing = ref<string | null>(null);
	const adding = ref(false);
	const dialog = ref<IgnoreDialog>(closed());

	/** A Lab Viewer reads the rules and may not change them (the server says so with can_remove false on every rule). */
	const readOnly = computed(() => rules.value.length > 0 && rules.value.every((r) => !r.can_remove));

	async function load(): Promise<void> {
		try {
			rules.value = await listIgnored(api);
			error.value = '';
			available.value = true;
		} catch (e) {
			// An older server has no such route: say nothing about it. Anything else keeps the last list, with the reason.
			if (e instanceof InboxApiError && e.status === 404) available.value = false;
			else error.value = words(e, 'Could not load the ignored folders.');
		} finally {
			loading.value = false;
		}
	}

	/**
	 * Ignore a folder (relative to its owner's root). Checked here first the way the server checks it; the server's own words come back for anything
	 * else. On success: the notice with the real count and a Remove rule button, and fresh lists. Errors are returned, for the form that asked.
	 */
	async function add(folder: string, teamId: string | null): Promise<Outcome> {
		const value = folder.trim();
		const problem = folderProblem(value);
		if (problem) return { ok: false, message: problem };
		if (adding.value) return { ok: false, message: 'A folder is already being added.' };
		adding.value = true;
		try {
			const r = await addIgnored(api, value, teamId);
			deps.say({ tone: 'ok', text: ignoredText(r.folder, r.dismissed), removeRule: r.ignored_id });
			await Promise.all([load(), deps.onChanged()]);
			return { ok: true };
		} catch (e) {
			// the list we hold is stale when the server says it is already there or the rules changed
			if (e instanceof InboxApiError && (e.status === 409 || e.status === 404)) void load();
			return { ok: false, message: words(e, 'Could not ignore that folder.') };
		} finally {
			adding.value = false;
		}
	}

	async function removeById(id: string): Promise<Outcome> {
		if (removing.value !== null) return { ok: false, message: 'A rule is already being removed.' };
		removing.value = id;
		try {
			const r = await removeIgnored(api, id);
			deps.say({ tone: 'ok', text: unignoredText(r.folder, r.rescan_queued) });
			error.value = '';
			await Promise.all([load(), deps.onChanged()]);
			return { ok: true };
		} catch (e) {
			const text = words(e, 'Could not remove that rule.');
			// the list we hold is stale when the rule is gone: read it again first (a good read clears the error), then say why
			if (e instanceof InboxApiError && e.status === 404) await load();
			error.value = text;
			return { ok: false, message: text };
		} finally {
			removing.value = null;
		}
	}
	const remove = (rule: IgnoredRule) => removeById(rule.ignored_id);

	/** "Ignore this folder" on a row: opens the confirm (nothing for a file that sits directly in its owner's root). */
	function openIgnore(file: FoundFile): void {
		const target = ignoreTarget(file);
		if (!target) return;
		dialog.value = { open: true, target, shown: shownBelow(deps.rows(), target), busy: false, error: '' };
	}
	const closeIgnore = () => {
		if (!dialog.value.busy) dialog.value = closed();
	};

	async function confirmIgnore(): Promise<Outcome> {
		const d = dialog.value;
		if (!d.open || !d.target || d.busy) return { ok: false, message: 'Nothing to confirm yet.' };
		dialog.value = { ...d, busy: true, error: '' };
		const r = await add(d.target.folder, d.target.teamId);
		if (r.ok) dialog.value = closed();
		else dialog.value = { ...dialog.value, busy: false, error: r.message };
		return r;
	}

	return { rules, loading, error, available, open, removing, adding, dialog, readOnly, load, add, remove, removeById, openIgnore, closeIgnore, confirmIgnore };
}
