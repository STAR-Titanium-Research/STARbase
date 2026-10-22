import { ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { deleteMeasurement, loadMeasurements, renameMeasurement, saveMeasurement, type NewMeasurement, type SavedMeasurement } from './inboxApi';
import { orderMeasurements } from './measurements';
import type { Outcome } from './useInbox';

// The saved measurements of the open file (the view box's Measurements list, spec 2026-10-20-inbox-file-viewer-design.md decision 6): read once per file, then
// kept in step with what this person saves, renames and deletes (each change is made on the server first, so what is shown is what is kept). No lifecycle hooks, so
// it is tested with the fake server; the page calls load() when the file changes. A read that fails leaves the list empty and says why (the picture and the
// other tools go on working); a change that fails keeps the list as it was and says why in `error`. One request at a time per kind of change is not enforced:
// the page disables a row while its own change is under way (`busy`).

export type MeasurementsStatus = 'idle' | 'loading' | 'ready' | 'error';

const textOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

export function createMeasurements(api: HostApi) {
	const gate = useRequestGate();
	const list = ref<SavedMeasurement[]>([]);
	/** The caller owns the file, so may save a shape on it (an administrator reads only). */
	const canChange = ref(false);
	const status = ref<MeasurementsStatus>('idle');
	/** Why the read or the last change failed ("" when nothing did). */
	const error = ref('');
	/** The shape highlighted on the picture, or null. */
	const selectedId = ref<string | null>(null);
	/** What is being changed now: 'save', or the id of the shape being renamed or deleted. */
	const busy = ref<string | null>(null);
	let candidate: string | null = null;

	/** Read the list of a file (null: no file, the list is empty). The answer of an older read, or of another file, is dropped. */
	async function load(candidateId: string | null): Promise<void> {
		const token = gate.begin();
		if (candidateId !== candidate) {
			list.value = [];
			canChange.value = false;
			selectedId.value = null;
		}
		candidate = candidateId;
		error.value = '';
		busy.value = null;
		if (candidateId === null) {
			status.value = 'idle';
			return;
		}
		status.value = 'loading';
		try {
			const got = await loadMeasurements(api, candidateId);
			if (!gate.isCurrent(token)) return;
			list.value = orderMeasurements(got.measurements);
			canChange.value = got.canChange;
			if (selectedId.value && !list.value.some((m) => m.measurement_id === selectedId.value)) selectedId.value = null;
			status.value = 'ready';
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			list.value = [];
			canChange.value = false;
			status.value = 'error';
			error.value = textOf(e, 'Could not load the measurements.');
		}
	}

	/** Run one change against the file that was open when it started; its answer is dropped when another file has been opened since. */
	async function change(who: string, work: (file: string) => Promise<void>, fallback: string): Promise<Outcome> {
		const file = candidate;
		if (file === null) return { ok: false, message: 'There is no file open.' };
		if (busy.value !== null) return { ok: false, message: 'Wait for the last change to finish.' };
		busy.value = who;
		error.value = '';
		try {
			await work(file);
			return { ok: true };
		} catch (e) {
			const message = textOf(e, fallback);
			if (candidate === file) error.value = message;
			return { ok: false, message };
		} finally {
			if (candidate === file && busy.value === who) busy.value = null;
		}
	}

	/** Save a shape (its corners in original pixels); the new row is selected. */
	const save = (input: NewMeasurement): Promise<Outcome> =>
		change('save', async (file) => {
			const saved = await saveMeasurement(api, file, input);
			if (candidate !== file) return;
			list.value = orderMeasurements([...list.value.filter((m) => m.measurement_id !== saved.measurement_id), saved]);
			selectedId.value = saved.measurement_id;
		}, 'Could not save the measurement.');

	/** Give a shape a name (an empty one takes it off). */
	const rename = (id: string, label: string): Promise<Outcome> =>
		change(id, async (file) => {
			const saved = await renameMeasurement(api, file, id, label);
			if (candidate !== file) return;
			list.value = list.value.map((m) => (m.measurement_id === id ? saved : m));
		}, 'Could not rename the measurement.');

	const remove = (id: string): Promise<Outcome> =>
		change(id, async (file) => {
			await deleteMeasurement(api, file, id);
			if (candidate !== file) return;
			list.value = list.value.filter((m) => m.measurement_id !== id);
			if (selectedId.value === id) selectedId.value = null;
		}, 'Could not delete the measurement.');

	/** Highlight a shape on the picture (null, or the one already selected, takes the highlight off). */
	function select(id: string | null): void {
		selectedId.value = id === null || id === selectedId.value ? null : list.value.some((m) => m.measurement_id === id) ? id : null;
	}

	return { list, canChange, status, error, selectedId, busy, load, save, rename, remove, select };
}
