import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { errorText, normaliseOverview, useRequestGate, type AdminOverview } from '@d1/ui';

// The admin panels' numbers: GET /d1-admin-overview (core/extensions/d1-admin-overview), read only
// when the host says the user is an admin (it answers 401/403 to anyone else). The whole call can
// fail (`error`); a part of it can fail on its own (that field of `data` is null). The first read
// shows `loading`; the refreshes after it are silent and keep what is on screen if one fails, so a
// blip does not blank the panels. The refresh keeps the crawler's "online" honest without a reload.
export const REFRESH_MS = 30_000;

export function useAdminOverview(isAdmin: Ref<boolean>) {
	const api = useApi();
	const gate = useRequestGate();
	const data = ref<AdminOverview | null>(null);
	const error = ref('');
	const loading = ref(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load(first: boolean) {
		const token = gate.begin();
		if (first) loading.value = true;
		try {
			const res = await api.get('/d1-admin-overview');
			const overview = normaliseOverview(res.data);
			if (!gate.isCurrent(token)) return;
			if (overview) {
				data.value = overview;
				error.value = '';
			} else if (first || !data.value) {
				error.value = 'The admin overview answered in a form that could not be read.';
			}
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (first || !data.value) error.value = errorText(e, 'Could not reach the admin overview');
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	// isAdmin starts as a guess and is corrected by the server: start when it is true, stop and forget when it turns false.
	watch(
		isAdmin,
		(admin) => {
			stop();
			if (!admin) {
				gate.cancel();
				data.value = null;
				error.value = '';
				loading.value = false;
				return;
			}
			load(true);
			timer = setInterval(() => load(false), REFRESH_MS);
		},
		{ immediate: true },
	);
	onBeforeUnmount(() => {
		stop();
		gate.cancel();
	});

	return { data, error, loading };
}
