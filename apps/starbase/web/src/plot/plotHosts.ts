import type { AxiosInstance } from 'axios';
import type { Router } from 'vue-router';
import type { ForceHost, ForceHostUser } from '@d1/force-plotting';
import type { FastHost } from '@d1/fast-plotting';
import { fetchCanUpdate, isLabViewerRole, openLink, recordRoute } from '@d1/ui';
import type { SessionGuard } from '../api';
import type { StarbaseConfig } from '../config';
import type { Session } from '../session';
import { downloadAsset, saveBlob } from './assetDownload';

// The plotters' host contracts, STARbase's cookie variant (spec §3.5). Type imports only: the plotting
// packages themselves load with their lazy plot pages (ForcePlotPage/FastPlotPage install these).

export interface PlotDeps {
	api: AxiosInstance;
	session: Pick<Session, 'user' | 'isAdmin'>;
	guard: Pick<SessionGuard, 'recover'>;
	router: Pick<Router, 'push'>;
	config: () => Readonly<StarbaseConfig>;
	/** Saves a downloaded file (a temporary <a download>); replaced in tests. */
	save?: (blob: Blob, filename: string) => void;
}

// The plotter scopes by admin role: the flag comes from the server (GET /policies/me/globals).
export function forceUser(session: Pick<Session, 'user' | 'isAdmin'>): ForceHostUser | null {
	const u = session.user.value;
	return u ? { ...u, admin_access: session.isAdmin.value } : null;
}

export function starbaseForceHost(deps: PlotDeps): ForceHost {
	const save = deps.save ?? saveBlob;
	return {
		api: deps.api,
		currentUser: () => forceUser(deps.session),
		get filterUrl() {
			return deps.config().filterUrl;
		},
		get diagUrl() {
			return deps.config().diagUrl;
		},
		get octreeUrl() {
			return deps.config().octreeUrl;
		},
		// The session cookie goes with every raw fetch to /filter and /diag (they forward it to Directus);
		// /octrees is public within the tailnet and is fetched without credentials by the plotter itself.
		authHeaders: () => ({}),
		fetchCredentials: 'include',
		// "Re-checks the session" (spec §3.5): renewed means retry once; a live session that refused, or no
		// session (the guard has sent the user to sign in), means no retry.
		refreshAuth: async () => (await deps.guard.recover(403)) === 'retry',
		openRecord: (collection, id) => openLink(recordRoute(collection, id), deps.router),
		// Fetched through the credentialed api (the session guard applies) and saved from memory, so the tab
		// never navigates: a failure rejects instead of replacing the plot with an error page.
		downloadAsset: (fileId) => downloadAsset(deps.api, String(fileId), save),
		dense: true,
	};
}

// canUpdate is the Operation page's own rights check (the kit's fetchCanUpdate: Directus's item permissions, false for a Lab
// Viewer without asking), so the plotter offers a Conform run's upload, window and unlink actions to exactly the people the
// Operation page offers its own to.
export function starbaseFastHost(deps: Pick<PlotDeps, 'api' | 'router'> & { session?: Pick<Session, 'user'> }): FastHost {
	return {
		api: deps.api,
		openRecord: (collection, id) => openLink(recordRoute(collection, id), deps.router),
		canUpdate: (collection, id) => fetchCanUpdate(deps.api, collection, id, isLabViewerRole(deps.session?.user.value?.role)),
	};
}
