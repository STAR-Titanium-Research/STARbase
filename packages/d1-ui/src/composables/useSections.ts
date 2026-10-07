import { ref, type Ref } from 'vue';
import { errorText } from '../format';

// The "sections that load on their own" pattern of every Explorer data composable (Sample,
// Operation, Test, Project, Campaign, My work): one root record decides between "page" and "Not
// found", and each related block is a section with its own data, loading flag and error, so one
// forbidden or failing list does not blank the page.
//
// ONE error behaviour, everywhere: a failed (re)load keeps the data the section already had and
// shows the error next to it, so a reload after an edit never wipes a list the user was reading.
// (A section that was never loaded simply has its initial value.) A stale answer, one whose
// request was replaced by a newer one or by unmount, is dropped through the gate and changes
// nothing.

/** The longest list a page shows; a read asks for one more row to know there is more. */
export const LIST_CAP = 200;

export interface SectionState<T> {
	data: T;
	loading: boolean;
	error: string;
}

export interface SectionGate {
	isCurrent(token: number): boolean;
}

export const sectionState = <T>(data: T, loading = false): SectionState<T> => ({ data, loading, error: '' });

export function useSections(gate: SectionGate) {
	/** A section starts with `initial` data; `loading` is true for blocks that show a skeleton at first. */
	const section = <T>(initial: T, loading = false) => ref(sectionState(initial, loading)) as Ref<SectionState<T>>;

	/**
	 * Runs one section's read. `onError` may turn a failure into a state of the caller's own (for
	 * example "your role cannot read this"): return true and no error line is shown.
	 */
	async function fill<T>(
		target: Ref<SectionState<T>>,
		token: number,
		what: string,
		read: () => Promise<T>,
		onError?: (e: unknown) => boolean,
	): Promise<void> {
		target.value = { ...target.value, loading: true, error: '' };
		try {
			const data = await read();
			if (gate.isCurrent(token)) target.value = { data, loading: false, error: '' };
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			const handled = onError?.(e) ?? false;
			target.value = { ...target.value, loading: false, error: handled ? '' : `Could not load ${what}: ${errorText(e)}` };
		}
	}

	return { section, fill };
}
