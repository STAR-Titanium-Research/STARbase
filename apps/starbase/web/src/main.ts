import { createApp, watch } from 'vue';
import { setPageFrame } from '@d1/starbase-pages';
// Bundled, not a CDN: Material Symbols as in the Force App (no network dependency for every icon).
import 'material-symbols/rounded.css';
import './theme.css';
import './styles.css';
import App from './App.vue';
import PlainFrame from './PlainFrame.vue';
import { createApi, installSessionGuard } from './api';
import { getConfig, loadRuntimeConfig } from './config';
import { APP } from './context';
import { createBrowserEditor } from './editor/browserEditor';
import { installStarbaseHost } from './host';
import { createStarbaseRouter } from './router';
import { createSession } from './session';
import { registerStandins } from './standins/register';

async function bootstrap() {
	await loadRuntimeConfig();
	const { directusUrl } = getConfig();
	const api = createApi(directusUrl);
	const session = createSession(api);
	const router = createStarbaseRouter(session);
	const editor = createBrowserEditor(directusUrl);

	// Any request that finds the session gone (signed out here, in Data Studio, or expired) lands on the
	// sign-in page, coming back to where it was (spec §4).
	const guard = installSessionGuard(api, () => {
		session.markSignedOut();
		const here = router.currentRoute.value;
		if (here.name === 'signin' || here.name === 'signin-done') return;
		void router.replace(here.fullPath === '/' ? '/signin' : `/signin?next=${encodeURIComponent(here.fullPath)}`);
	});

	setPageFrame(PlainFrame);
	// One Explorer host per signed-in user. 'sync' so it exists before the first page's setup runs (the
	// guard sets the user, then the navigation renders the page).
	watch(
		() => session.user.value?.id,
		(id) => {
			if (id) installStarbaseHost({ api, session, router, directusUrl, openEditor: (collection, id) => editor.open(collection, id) });
		},
		{ flush: 'sync', immediate: true },
	);

	const app = createApp(App);
	app.provide(APP, { api, session, guard, editor });
	registerStandins(app);
	app.use(router);
	app.mount('#app');
}

void bootstrap();
