import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useExplorerHost, errorText, isAuthRefusal, normaliseOverview, useRequestGate, type AdminOverview } from '@d1/ui';

// The admin panels' numbers: GET /d1-admin-overview (core/extensions/d1-admin-overview), read only
// while `active` is true, which the caller sets from the server-confirmed admin flag (not the
// host's first guess, so a member is never sent to an admin-only endpoint). A 401/403 is silence:
// no error line, no more requests until `active` toggles again.
//
// The whole call can fail (`error`); a part of it can fail on its own (that field of `data` is
// null). `loading` is true for the first read only. The refreshes after it are silent, keep what is
// on screen if one fails, never overlap a read still in flight, and pause while the tab is hidden
// (one read when it comes back). `fetchedAt` is the browser time the data arrived: with the answer's
// `serverTime` it gives the reference clock for "online" and "x ago" (see overviewTime).
export const REFRESH_MS = 30_000;
const TIMEOUT_MS = 20_000;

export function useAdminOverview(active: Ref<boolean>) {
	const api = useExplorerHost().api;
	const gate = useRequestGate();
	const data = ref<AdminOverview | null>(null);
	const error = ref('');
	const loading = ref(false);
	const fetchedAt = ref(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;
	let busy = false;
	let refused = false;

	async function load() {
		if (busy || refused) return;
		busy = true;
		const token = gate.begin();
		const first = !data.value;
		if (first) loading.value = true;
		try {
			const res = await api.get('/d1-admin-overview', { timeout: TIMEOUT_MS });
			if (!gate.isCurrent(token)) return;
			const overview = normaliseOverview(res.data);
			if (overview) {
				data.value = overview;
				fetchedAt.value = Date.now();
				error.value = '';
			} else if (first) {
				error.value = 'The admin overview answered in a form that could not be read.';
			}
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isAuthRefusal(e)) {
				refused = true;
				stop();
				data.value = null;
				error.value = '';
			} else if (first) {
				error.value = errorText(e, 'Could not reach the admin overview');
			}
		} finally {
			// Only the current read owns the flags: a read cancelled by a toggle must not clear a newer one's.
			if (gate.isCurrent(token)) {
				busy = false;
				loading.value = false;
			}
		}
	}

	function onVisible() {
		if (!document.hidden) load();
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = null;
		document.removeEventListener('visibilitychange', onVisible);
	}

	watch(
		active,
		(on) => {
			stop();
			refused = false;
			gate.cancel();
			busy = false;
			if (!on) {
				data.value = null;
				error.value = '';
				loading.value = false;
				return;
			}
			load();
			// No timer at all for a non-admin (the branch above); none work while the tab is hidden.
			timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
			document.addEventListener('visibilitychange', onVisible);
		},
		{ immediate: true },
	);
	onBeforeUnmount(() => {
		stop();
		gate.cancel();
	});

	return { data, error, loading, fetchedAt };
}
