// The "Samples" bookmark on physical_samples (defined in scripts/configure_directus.sql): Home's
// "View samples" link goes to it rather than the bare collection, so users land on the same
// curated view as the sidebar bookmark. It is found by name, since its id differs between
// installs; if it is not found the link opens the collection's default view.
import { collectionRoute } from '@d1/ui';

export const SAMPLES_LIST = collectionRoute('physical_samples');
const SAMPLES_BOOKMARK_NAME = 'Samples';

type Api = { get: (url: string, config?: any) => Promise<any> };

// The id of a named bookmark on a collection, or null when there is none (or the role cannot read
// presets). Prefers the global bookmark, then a role's, then the user's own.
export async function bookmarkId(api: Api, collection: string, name: string): Promise<number | null> {
	try {
		const res = await api.get('/presets', {
			params: {
				filter: { bookmark: { _eq: name }, collection: { _eq: collection } },
				fields: ['id', 'user', 'role'],
				sort: ['id'],
				limit: -1,
			},
		});
		const rows: { id: number; user: string | null; role: string | null }[] = res.data.data ?? [];
		const pick = rows.find((r) => !r.user && !r.role) ?? rows.find((r) => !r.user) ?? rows[0];
		return pick ? pick.id : null;
	} catch {
		return null;
	}
}

export async function samplesBookmarkLink(api: Api): Promise<string> {
	const id = await bookmarkId(api, 'physical_samples', SAMPLES_BOOKMARK_NAME);
	return id === null ? SAMPLES_LIST : `${SAMPLES_LIST}?bookmark=${id}`;
}
