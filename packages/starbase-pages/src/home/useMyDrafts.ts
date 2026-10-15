import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorText, useExplorerHost, useRequestGate } from '@d1/ui';
import type { DraftListEntry, HostApi } from '@d1/ui';

// "My drafts" on Home (spec E3, §7.2): what the signed-in person has built in the Process map's edit mode and not created yet,
// from GET /d1-build/drafts as the caller (the server returns only their own). The block loads and fails on its own, like the
// other Home blocks, and draws nothing when there is nothing to show: no drafts, or no `d1-build` on this server yet (404), or a
// role that may not build (403), since Home must work before the server side is deployed.

/** Drafts shown on Home; the rest are in the Open menu of the map. */
export const SHOWN = 8;

/** Where a draft opens: the map in edit mode (the Directus form of the path; links.ts maps it per host). */
export const draftPath = (id: string): string => `/map?edit=${encodeURIComponent(id)}`;

/** The list out of the endpoint's answer `{ data: [...] }`: rows without an id are dropped, newest first. */
export function parseDrafts(body: unknown): DraftListEntry[] {
	const rows = (body as { data?: unknown } | null | undefined)?.data;
	if (!Array.isArray(rows)) return [];
	const out: DraftListEntry[] = [];
	for (const r of rows) {
		if (!r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string' || !(r as { id: string }).id) continue;
		const e = r as Partial<DraftListEntry> & { id: string };
		out.push({ id: e.id, name: typeof e.name === 'string' && e.name.trim() ? e.name : 'Untitled draft', updated_at: typeof e.updated_at === 'string' ? e.updated_at : '', summary: typeof e.summary === 'string' ? e.summary : '' });
	}
	return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

const status = (e: any): number | undefined => e?.response?.status;

/** The state and the read, without lifecycle hooks (useMyDrafts adds them), so it is testable with a fake api. */
export function createMyDrafts(api: HostApi) {
	const gate = useRequestGate();
	const drafts = ref<DraftListEntry[]>([]);
	const loading = ref(true);
	const error = ref('');
	// The server cannot say (404: no d1-build yet; 403: this role may not build): the block is left out, not shown as an error.
	const absent = ref(false);

	async function load(): Promise<void> {
		const token = gate.begin();
		try {
			const res = await api.get('/d1-build/drafts');
			if (!gate.isCurrent(token)) return;
			drafts.value = parseDrafts(res?.data);
			error.value = '';
			absent.value = false;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (status(e) === 404 || status(e) === 403) {
				absent.value = true;
				drafts.value = [];
				error.value = '';
			} else {
				// A failed reload keeps what was shown, with the reason.
				error.value = `Could not read your drafts: ${errorText(e)}`;
			}
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	/** Draw the block: drafts to show, or a failure to say. Never an empty box. */
	const visible = computed(() => !absent.value && (drafts.value.length > 0 || !!error.value));
	const shown = computed(() => drafts.value.slice(0, SHOWN));
	const more = computed(() => Math.max(0, drafts.value.length - SHOWN));

	return { drafts, shown, more, loading, error, absent, visible, load, cancel: () => gate.cancel() };
}

export function useMyDrafts() {
	const state = createMyDrafts(useExplorerHost().api);
	onMounted(() => void state.load());
	onBeforeUnmount(() => state.cancel());
	return state;
}
