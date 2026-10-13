import { ref } from 'vue';

// Settings saves each control as it changes (spec decision 9). usePins applies a change at once, sends it
// and undoes it when the send fails, saying so only on the sidebar's quiet notice. Settings also says it
// beside the control: a job reports whether its change stuck, a failed one is remembered under the
// control's key, and Retry runs the same job again. A later success under the key clears it.
export function useSaves() {
	const failed = ref<Record<string, true>>({});
	const retries = new Map<string, () => Promise<void>>();

	async function run(key: string, job: () => Promise<boolean>): Promise<void> {
		let ok = false;
		try {
			ok = await job();
		} catch {
			ok = false;
		}
		if (ok) {
			retries.delete(key);
			if (failed.value[key]) {
				const { [key]: _gone, ...rest } = failed.value;
				failed.value = rest;
			}
		} else {
			retries.set(key, () => run(key, job));
			failed.value = { ...failed.value, [key]: true };
		}
	}

	const hasFailed = (key: string): boolean => !!failed.value[key];
	const retry = (key: string): Promise<void> => retries.get(key)?.() ?? Promise.resolve();

	return { run, hasFailed, retry };
}

export type Saves = ReturnType<typeof useSaves>;
