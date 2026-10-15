// The Team filter of a page that filters on the client (the Projects index): the teams to choose from, the chosen team in the URL (`f.team=<id>`,
// like the index kit's chip) and the ids of that team's records of one collection that the viewer can read (GET /d1-teams/:id/records, Ruling M1).
// Host-neutral: the API and the route come in as arguments. Until the ids are known, or when they cannot be had, `ids` is an EMPTY set, so a page
// that filters on it shows nothing rather than every record.
import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue';
import type { ExplorerHost } from '../host';
import { errorText } from '../format';
import { useRequestGate } from '../composables/useRequestGate';
import { TEAM_RECORDS_LIMIT, getTeamRecordIds, listTeams } from './teamsApi';
import { TEAM_FILTER_FIELD } from '../index/indexConfig';
import { teamTruncatedNote } from '../index/indexView';

export interface TeamRouteLike {
	path: string;
	query: Record<string, any>;
}
export interface TeamRouterLike {
	replace(to: { path: string; query: Record<string, string> }): unknown;
}

const NONE: ReadonlySet<string> = new Set();
const QUERY_KEY = `f.${TEAM_FILTER_FIELD}`;

export function useTeamRecordFilter(host: ExplorerHost, collection: string, route: TeamRouteLike, router: TeamRouterLike) {
	const gate = useRequestGate();
	const teams = ref<{ value: string; label: string }[]>([]);
	const ids = ref<ReadonlySet<string>>(NONE);
	const note = ref('');
	const error = ref('');
	const loading = ref(false);

	const team = computed(() => {
		const raw = route.query[QUERY_KEY];
		const value = Array.isArray(raw) ? raw[0] : raw;
		return typeof value === 'string' ? value : '';
	});

	async function loadTeams(): Promise<void> {
		try {
			teams.value = (await listTeams(host.api)).map((t) => ({ value: t.team_id, label: t.name }));
		} catch {
			teams.value = []; // no teams to choose from; a team already in the URL still filters
		}
	}

	async function loadIds(): Promise<void> {
		const token = gate.begin();
		ids.value = NONE;
		note.value = '';
		error.value = '';
		if (!team.value) {
			loading.value = false;
			return;
		}
		loading.value = true;
		try {
			const found = await getTeamRecordIds(host.api, team.value, collection, TEAM_RECORDS_LIMIT);
			if (!gate.isCurrent(token)) return;
			ids.value = new Set(found.ids);
			note.value = found.truncated ? teamTruncatedNote(TEAM_RECORDS_LIMIT) : '';
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			error.value = errorText(e, "Could not load this team's records");
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	function setTeam(value: string): void {
		const query: Record<string, string> = {};
		for (const [k, v] of Object.entries(route.query)) {
			const first = Array.isArray(v) ? v[0] : v;
			if (k !== QUERY_KEY && typeof first === 'string') query[k] = first;
		}
		if (value) query[QUERY_KEY] = value;
		void router.replace({ path: route.path, query });
	}

	void loadTeams();
	watch(team, () => void loadIds(), { immediate: true });
	if (getCurrentInstance()) onBeforeUnmount(() => gate.cancel());

	return { teams, team, ids, note, error, loading, setTeam };
}
