import { computed, ref } from 'vue';
import type { HostApi } from '@d1/ui';
import { aliasProblem, clean, folderPatch, folderSaveError } from '../inbox/folderModel';

// The inbox crawler's two fields on a person (migration 193), for the People edit dialog (administrators): `uni_alias` (the folder under Users/)
// and `scan_while_former`. Not part of the People endpoint's rows, so an existing person's values are read through /items/people as the
// administrator, and only a change is sent. The database refuses an alias on a new row (a trigger), so a new person is created first and the
// fields are set by a second PATCH; if that fails the person stays and the message says what was and was not saved.
// No lifecycle hooks: the dialog calls load() and reset(); this is tested with a fake api.

export function createPersonFolder(api: HostApi) {
	const alias = ref('');
	const scanFormer = ref(false);
	const serverAlias = ref<string | null>(null);
	const serverScan = ref(false);
	/** The fields are editable: a new person (nothing to read) or an existing one whose values were read. */
	const ready = ref(true);
	const loadError = ref('');
	const issue = computed(() => aliasProblem(alias.value));

	function reset(existing: boolean): void {
		alias.value = '';
		scanFormer.value = false;
		serverAlias.value = null;
		serverScan.value = false;
		loadError.value = '';
		ready.value = !existing;
	}

	async function load(personId: string): Promise<void> {
		ready.value = false;
		loadError.value = '';
		try {
			const res = await api.get(`/items/people/${encodeURIComponent(personId)}`, { params: { fields: ['uni_alias', 'scan_while_former'] } });
			const row = res?.data?.data ?? {};
			serverAlias.value = typeof row.uni_alias === 'string' ? row.uni_alias : null;
			serverScan.value = row.scan_while_former === true;
			alias.value = serverAlias.value ?? '';
			scanFormer.value = serverScan.value;
			ready.value = true;
		} catch {
			loadError.value = "Could not read this person's uni alias, so it cannot be changed here.";
		}
	}

	/** What an existing person's PATCH carries for these fields: only what changed (nothing until the values were read). */
	function changes(): Record<string, string | boolean | null> {
		if (!ready.value) return {};
		return { ...folderPatch('uni_alias', alias.value, serverAlias.value), ...(scanFormer.value !== serverScan.value ? { scan_while_former: scanFormer.value } : {}) };
	}

	/** Does a new person have anything to set? */
	const wantsAfterCreate = (): boolean => !!clean(alias.value) || scanFormer.value;

	/**
	 * Set the fields on the person just created. Returns null when they are saved (or nothing was to be saved), else the message to show. On a
	 * failure the fields now stand for the existing person, so the next Save sends the change as an edit.
	 */
	async function afterCreate(personId: unknown, name: string): Promise<string | null> {
		if (!wantsAfterCreate()) return null;
		const patch = { ...folderPatch('uni_alias', alias.value, null), ...(scanFormer.value ? { scan_while_former: true } : {}) };
		try {
			if (typeof personId !== 'string' || !personId) throw new Error('The server did not say which person was added.');
			await api.patch(`/items/people/${encodeURIComponent(personId)}`, patch);
			return null;
		} catch (e) {
			serverAlias.value = null;
			serverScan.value = false;
			ready.value = true;
			return `${name} was added, but the folder settings were not saved: ${folderSaveError(e, 'alias', 'Could not save.', { only: true })}`;
		}
	}

	return { alias, scanFormer, ready, loadError, issue, reset, load, changes, afterCreate };
}
