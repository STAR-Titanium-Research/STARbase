import { onBeforeUnmount, ref } from 'vue';
import {
	CURRENT_USER, campaignsMine, isFilterRefused, ownedByMe, projectsMine, samplesMine, useItems,
	useRequestGate, useSections, withMyTeams,
} from '@d1/ui';
import { MY_TEAMS_UNREAD, loadMyTeamIds } from './myTeams';

// "My work" on Home: the projects where I am PI or investigator, the campaigns I own and my newest samples, read as the
// signed-in user with explicit "mine" filters (see packages/d1-ui/src/mine.ts): a PI can read more
// than they own (ADR-0011), and "my work" is the narrower, personal list. Each list loads and fails
// on its own. The campaigns and samples are also those owned by a team I belong to (owner_team_id in my team ids, read once from
// /items/team_members); when the memberships cannot be read the lists show my own records and a note says so.

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
	const partialTeams = ref('');

	// Try the full filter; if the server refuses it (400, 403, 404 or a 5xx: a role that may not read the
	// junction, or a filter Directus rejects), fall back to the owner-only half and set the note, so a bad
	// filter can never blank Home. A network failure is rethrown (the fallback would fail too) and the
	// section shows the real error. If the fallback itself fails, that error is shown.
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
			if (!isFilterRefused(e)) throw e;
			const rows = await getItems(collection, { ...params, filter: fallback });
			onFallback();
			return rows;
		}
	}

	async function load() {
		const token = gate.begin();
		partialProjects.value = '';
		partialSamples.value = '';
		partialTeams.value = '';
		// my teams, read beside everything else; the campaign and sample reads wait for it (it never rejects)
		const myTeams = loadMyTeamIds(getItems).then((t) => {
			if (t.unread && gate.isCurrent(token)) partialTeams.value = MY_TEAMS_UNREAD;
			return t.ids;
		});
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
			fill(campaigns, token, 'your campaigns', async () =>
				getItems('campaigns', {
					filter: withMyTeams(campaignsMine, await myTeams),
					fields: ['campaign_id', 'campaign_code', 'name', 'campaign_type', 'status', 'project_id.project_code'],
					sort: ['-updated_at'],
					limit: CARD_LIMIT,
				}),
			),
			fill(samples, token, 'your samples', async () => {
				const teams = await myTeams;
				return withFallback(
					'physical_samples',
					withMyTeams(samplesMine, teams),
					withMyTeams(ownedByMe, teams),
					{
						fields: ['sample_id', 'sample_code', 'form', 'current_status', 'updated_at', 'material_id.common_name'],
						sort: ['-updated_at'],
						limit: SAMPLE_LIMIT,
					},
					() => { if (gate.isCurrent(token)) partialSamples.value = 'Samples you co-own may be missing: you cannot read the co-owner list.'; },
				);
			}),
		]);
	}

	load();
	onBeforeUnmount(() => gate.cancel());
	return { projects, campaigns, samples, hasPerson, partialProjects, partialSamples, partialTeams, reload: load };
}
