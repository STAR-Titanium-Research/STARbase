import { onBeforeUnmount, ref } from 'vue';
import {
	CURRENT_USER, campaignsMine, isForbidden, isNotVisible, ownedByMe, projectsMine, samplesMine, useItems,
	useRequestGate, useSections,
} from '@d1/ui';

// "My work" on Home: the projects where I am PI or investigator, the campaigns I own and my newest samples, read as the
// signed-in user with explicit "mine" filters (see packages/d1-ui/src/mine.ts): a PI can read more
// than they own (ADR-0011), and "my work" is the narrower, personal list. Each list loads and fails
// on its own.

export const CARD_LIMIT = 12;
export const SAMPLE_LIMIT = 10;

export function useMyWork() {
	const { getItems } = useItems();
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);

	const projects = section<any[]>([], true);
	const campaigns = section<any[]>([], true);
	const samples = section<any[]>([], true);
	// null until known. A user with no people row owns nothing by the owner path, which is worth
	// saying out loud rather than showing three empty lists.
	const hasPerson = ref<boolean | null>(null);
	// Set when the co-owner / investigator half of a filter could not be applied (a role that may
	// not read the junction): that list then shows ownership / PI only. One note per list.
	const partialProjects = ref('');
	const partialSamples = ref('');

	// Try the full filter; if Directus refuses it (403 / not visible), fall back to the owner-only
	// half and set the note. Any other failure (network, 5xx, a bad filter) is rethrown so the
	// section shows the real error instead of a quietly narrower list.
	async function withFallback(
		collection: string,
		full: Record<string, unknown>,
		fallback: Record<string, unknown>,
		params: Record<string, unknown>,
		onFallback: () => void,
	) {
		try {
			return await getItems(collection, { ...params, filter: full });
		} catch (e: any) {
			if (!isForbidden(e) && !isNotVisible(e)) throw e;
			const rows = await getItems(collection, { ...params, filter: fallback });
			onFallback();
			return rows;
		}
	}

	async function load() {
		const token = gate.begin();
		partialProjects.value = '';
		partialSamples.value = '';
		await Promise.all([
			(async () => {
				try {
					const rows = await getItems('people', { filter: { user_id: { _eq: CURRENT_USER } }, fields: ['person_id'], limit: 1 });
					if (gate.isCurrent(token)) hasPerson.value = rows.length > 0;
				} catch {
					if (gate.isCurrent(token)) hasPerson.value = null;
				}
			})(),
			fill(projects, token, 'your projects', () =>
				withFallback(
					'projects',
					projectsMine,
					{ principal_investigator_person: { user_id: { _eq: CURRENT_USER } } },
					{
						fields: ['project_id', 'project_code', 'project_name', 'is_active', 'principal_investigator_person.full_name', 'principal_investigator_person.user_id'],
						sort: ['project_code'],
						limit: CARD_LIMIT,
					},
					() => { if (gate.isCurrent(token)) partialProjects.value = 'Projects where you are an investigator may be missing: you cannot read the investigator list.'; },
				),
			),
			fill(campaigns, token, 'your campaigns', () =>
				getItems('campaigns', {
					filter: campaignsMine,
					fields: ['campaign_id', 'campaign_code', 'name', 'campaign_type', 'status', 'project_id.project_code'],
					sort: ['-updated_at'],
					limit: CARD_LIMIT,
				}),
			),
			fill(samples, token, 'your samples', () =>
				withFallback(
					'physical_samples',
					samplesMine,
					ownedByMe,
					{
						fields: ['sample_id', 'sample_code', 'form', 'current_status', 'updated_at', 'material_id.common_name'],
						sort: ['-updated_at'],
						limit: SAMPLE_LIMIT,
					},
					() => { if (gate.isCurrent(token)) partialSamples.value = 'Samples you co-own may be missing: you cannot read the co-owner list.'; },
				),
			),
		]);
	}

	load();
	onBeforeUnmount(() => gate.cancel());
	return { projects, campaigns, samples, hasPerson, partialProjects, partialSamples, reload: load };
}
