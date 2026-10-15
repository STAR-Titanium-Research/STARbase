import { computed, ref } from 'vue';
import type { HostApi } from '@d1/ui';
import { clean, folderPatch, folderSaveError, shareFolderProblem } from '../inbox/folderModel';

// The team's `share folder` (migration 193: its folder under Shared/ on the lab share), for the Team edit dialog (administrators). The teams
// endpoint (d1-teams) does not take it, so it is read and written through /items/teams as the administrator, after the team itself is saved.
// Only a change is sent. No lifecycle hooks: the dialog calls load() and reset(); this is tested with a fake api.

export function createTeamFolder(api: HostApi) {
	const folder = ref('');
	const serverValue = ref<string | null>(null);
	/** The field is editable: a new team (nothing to read) or an existing one whose value was read. */
	const ready = ref(true);
	const loadError = ref('');
	const issue = computed(() => shareFolderProblem(folder.value));

	function reset(existing: boolean): void {
		folder.value = '';
		serverValue.value = null;
		loadError.value = '';
		ready.value = !existing;
	}

	async function load(teamId: string): Promise<void> {
		ready.value = false;
		loadError.value = '';
		try {
			const res = await api.get(`/items/teams/${encodeURIComponent(teamId)}`, { params: { fields: ['share_folder'] } });
			const v = res?.data?.data?.share_folder;
			serverValue.value = typeof v === 'string' ? v : null;
			folder.value = serverValue.value ?? '';
			ready.value = true;
		} catch {
			loadError.value = "Could not read this team's share folder, so it cannot be changed here.";
		}
	}

	/** Has the administrator changed it (and may it be sent)? */
	const changed = (): boolean => ready.value && Object.keys(folderPatch('share_folder', folder.value, serverValue.value)).length > 0;

	/**
	 * Save it on the team (after the team itself was saved). Returns null when it is saved or there was nothing to save, else the message to
	 * show, which says the team was saved.
	 */
	async function apply(teamId: string, teamName: string): Promise<string | null> {
		if (!changed()) return null;
		const patch = folderPatch('share_folder', folder.value, serverValue.value);
		try {
			await api.patch(`/items/teams/${encodeURIComponent(teamId)}`, patch);
			serverValue.value = clean(folder.value) || null;
			return null;
		} catch (e) {
			return `${teamName} was saved, but the share folder was not: ${folderSaveError(e, 'share_folder', 'Could not save.', { only: true })}`;
		}
	}

	return { folder, ready, loadError, issue, reset, load, changed, apply };
}
