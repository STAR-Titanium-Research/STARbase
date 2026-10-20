// The projects and campaigns the draft's chooser offers (R12): read once, as the signed-in user, through `/items` (Directus permissions decide
// what is listed). Talks to the server only through the HostApi it is given (the Explorer host's, in the page).

import { ref, shallowRef } from 'vue';
import { errorText, type HostApi } from '@d1/ui';
import { optionLabel, type CampaignOption, type ProjectOption } from './projectCampaign';

/** How many of each are asked for; a longer list says so. */
export const CHOICES_LIMIT = 500;

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { project_id?: unknown }).project_id === 'string' ? (v as { project_id: string }).project_id : null);

export function useProjectChoices(api: HostApi) {
	const projects = shallowRef<ProjectOption[]>([]);
	const campaigns = shallowRef<CampaignOption[]>([]);
	const error = ref('');
	const loaded = ref(false);
	let pending: Promise<void> | null = null;

	async function read(): Promise<void> {
		const notes: string[] = [];
		const [p, c] = await Promise.allSettled([
			api.get('/items/projects', { params: { fields: ['project_id', 'project_code', 'project_name'], sort: ['project_code'], limit: CHOICES_LIMIT } }),
			api.get('/items/campaigns', { params: { fields: ['campaign_id', 'campaign_code', 'name', 'project_id'], sort: ['campaign_code'], limit: CHOICES_LIMIT } }),
		]);
		if (p.status === 'fulfilled') {
			const rows = (p.value.data?.data ?? []) as Record<string, string | null>[];
			projects.value = rows.map((r) => ({ value: String(r.project_id), label: optionLabel(r.project_code, r.project_name, 'Project') }));
			if (rows.length >= CHOICES_LIMIT) notes.push(`The project list shows the first ${CHOICES_LIMIT}.`);
		} else notes.push(`Could not load the projects: ${errorText(p.reason)}`);
		if (c.status === 'fulfilled') {
			const rows = (c.value.data?.data ?? []) as Record<string, unknown>[];
			campaigns.value = rows.map((r) => ({ value: String(r.campaign_id), label: optionLabel(r.campaign_code as string | null, r.name as string | null, 'Campaign'), projectId: idOf(r.project_id) }));
			if (rows.length >= CHOICES_LIMIT) notes.push(`The campaign list shows the first ${CHOICES_LIMIT}.`);
		} else notes.push(`Could not load the campaigns: ${errorText(c.reason)}`);
		error.value = notes.join(' ');
		loaded.value = true;
	}

	/** Reads the lists the first time; later calls wait for that read. */
	function ensure(): Promise<void> {
		if (loaded.value) return Promise.resolve();
		return (pending ??= read().finally(() => void (pending = null)));
	}
	/** Reads them again (after something may have changed). */
	function reload(): Promise<void> {
		return (pending ??= read().finally(() => void (pending = null)));
	}

	return { projects, campaigns, error, loaded, ensure, reload };
}

export type ProjectChoices = ReturnType<typeof useProjectChoices>;
