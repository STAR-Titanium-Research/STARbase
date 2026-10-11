// What the recorder is told when the operator presses Run now (see AcceptContext): read from the
// signed-in user, the desktop shell and the upload queue at that moment. Kept apart from the store
// so the store's tests don't load the auth and upload modules.
import { authStore } from '../authStore';
import { CHANGELOG } from '../changelog';
import { syncStatus } from '../record/directusSync';
import { appVersionOf, operatorName, type AcceptContext } from './rigTestLogic';

async function shellVersion(): Promise<string | undefined> {
	try { return (await window.forceApp?.getUpdateInfo())?.version; } catch { return undefined; } // browser build or bridge down
}

export async function currentAcceptContext(): Promise<AcceptContext> {
	return {
		uploadBusy: syncStatus.syncing,
		operator: operatorName(authStore.currentUser.value),
		appVersion: appVersionOf(await shellVersion(), CHANGELOG[0]?.version),
	};
}
