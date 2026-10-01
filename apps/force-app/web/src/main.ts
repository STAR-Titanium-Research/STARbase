import { createApp } from 'vue';
import { setForceHost } from '@d1/force-plotting';
import { loadRuntimeConfig, getConfig } from './config';
import { router } from './router';
import { api, authHeaders, setUnauthorizedHandler } from './directusClient';
import { authStore } from './authStore';
import { startLookupSync } from './record/lookupCache';
import { startSync } from './record/directusSync';
import { installGlobalErrorReporting, reportClientError } from './clientLog';
import App from './App.vue';
import VIcon from './shims/VIcon.vue';
import VProgressCircular from './shims/VProgressCircular.vue';
import './theme'; // applies the persisted theme attribute before first paint
// Bundled, not the Google Fonts CDN: the acquisition PC is often offline, and there every icon
// rendered as its ligature name ("fiber_manual_record", "drag_indicator") and broke the layouts
// around it. Same file byte-for-byte as the CDN's, so nothing changes visually online.
import 'material-symbols/rounded.css';
import './styles.css';

async function bootstrap() {
	// Honour an optional runtime /config.json before anything reads the service URLs.
	await loadRuntimeConfig();

	// Install the shared plotting package's host ONCE, here, at app start. Every window (including
	// the pop-outs) boots through this file, so no component installs its own. Every FrmCloud consumer (FrmPanel.vue on
	// /record, LocalCaptureView.vue on /plot/local/:id) calls useForceHost() unconditionally in
	// its own setup() -- with no host installed yet, that threw "no host installed" the instant a
	// recording finished and FrmPanel swapped its v-if from LiveFrm to FrmCloud, UNLESS the user
	// had already visited /plot earlier in the session (whichever page mounted first happened to
	// install the module-singleton host for the rest of the session). Pre-existing bug, found
	// while visually verifying the buildCloud/path-model refactor
	// (docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md) -- fixed here
	// rather than left as a note, since it sat directly in the rendering path that work touches.
	setForceHost({
		api,
		currentUser: () => authStore.currentUser.value,
		get filterUrl() { return getConfig().filterUrl; },
		get diagUrl() { return getConfig().diagUrl; },
		get octreeUrl() { return getConfig().octreeUrl; },
		authHeaders,
		refreshAuth: () => authStore.refresh(),
		fetchCredentials: 'omit',
		openRecord: (collection, id) => {
			window.open(`${getConfig().directusUrl}/admin/content/${collection}/${id}`, '_blank', 'noopener');
		},
		downloadAsset: async (fileId) => {
			try {
				const res = await api.get(`/assets/${fileId}`, { params: { download: '' }, responseType: 'blob' });
				const url = URL.createObjectURL(res.data as Blob);
				const a = document.createElement('a');
				a.href = url; a.download = String(fileId);
				document.body.appendChild(a); a.click(); a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 10_000);
			} catch { /* best-effort */ }
		},
		dense: true,
	});

	const app = createApp(App);

	// Register the two Directus global components the ported plotting UI relies on.
	app.component('v-icon', VIcon);
	app.component('v-progress-circular', VProgressCircular);

	app.use(router);

	// Vue-level errors (component render/setup/lifecycle) don't reach window.onerror, so they need
	// their own hook; window.onerror/unhandledrejection catch everything else (plain JS, promises).
	app.config.errorHandler = (err, _instance, info) => {
		console.error(err, info);
		reportClientError(`${(err as Error)?.stack || err} (${info})`, 'vue', router.currentRoute.value.fullPath);
	};
	installGlobalErrorReporting(() => router.currentRoute.value.fullPath);

	// When a token refresh fails mid-request, drop the user back to the login screen.
	setUnauthorizedHandler(() => {
		if (router.currentRoute.value.name !== 'login') {
			router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
		}
	});

	app.mount('#app');

	// Background work that has to run whichever page is open: push queued run records when the
	// network returns, and keep the offline copy of the picker data fresh while connected.
	startSync();
	startLookupSync();
}

bootstrap();
