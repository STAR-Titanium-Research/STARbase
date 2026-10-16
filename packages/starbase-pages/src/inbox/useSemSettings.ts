import { computed, ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { InboxApiError, correctSemSetting, getSemSettings, type SemSettingsAnswer, type SemSettingsRead } from './inboxApi';
import { editDraft, parseEdit, settingRows } from './semSettings';

export const ONLY_OWNER_TEXT = "Only the file's owner can correct this.";

export type SemState = 'loading' | 'locked' | 'none' | 'settings' | 'error';

const readOf = (a: SemSettingsAnswer | null): SemSettingsRead | null => (a && !a.locked && a.settings ? (a as SemSettingsRead) : null);

/**
 * The imaging settings of one file on a record page (spec 2026-10-16-sem-data-bar-reader-design.md section 6): the answer of GET /d1-inbox/sem-settings,
 * the rows to draw, and the owner's edit of one field at a time. The answer of a file the page has since moved on from is dropped (latest wins).
 * A save shows what the server answers (the field `manual`); a 400 keeps the box open with the server's message; a 403 says only the owner can
 * correct it and takes the edit controls away.
 */
export function createSemSettings(api: HostApi, fileId: () => string) {
	const gate = useRequestGate();
	const answer = ref<SemSettingsAnswer | null>(null);
	const error = ref('');
	const editing = ref<string | null>(null);
	const draft = ref('');
	const saving = ref(false);
	const fieldError = ref<{ key: string; text: string } | null>(null);

	const data = computed(() => readOf(answer.value));
	const canEdit = computed(() => data.value?.can_edit === true);
	const state = computed<SemState>(() => {
		if (!answer.value) return error.value ? 'error' : 'loading';
		if (answer.value.locked) return 'locked';
		return answer.value.settings ? 'settings' : 'none';
	});
	const rows = computed(() => (data.value ? settingRows({ values: data.value.settings, sources: data.value.sources, flags: data.value.flags }, { all: data.value.can_edit }) : []));

	async function load(): Promise<void> {
		const token = gate.begin();
		const id = fileId();
		answer.value = null;
		error.value = '';
		editing.value = null;
		fieldError.value = null;
		try {
			const a = await getSemSettings(api, id);
			if (gate.isCurrent(token)) answer.value = a;
		} catch (e) {
			if (gate.isCurrent(token)) error.value = e instanceof Error && e.message ? e.message : 'Could not load the imaging settings.';
		}
	}

	function start(key: string): void {
		if (!canEdit.value || !data.value) return;
		editing.value = key;
		draft.value = editDraft(key, data.value.settings);
		fieldError.value = null;
	}
	function cancel(): void {
		editing.value = null;
		fieldError.value = null;
	}

	async function save(): Promise<void> {
		const key = editing.value;
		if (!key || saving.value) return;
		const parsed = parseEdit(key, draft.value);
		if ('error' in parsed) {
			fieldError.value = { key, text: parsed.error };
			return;
		}
		const id = fileId();
		saving.value = true;
		fieldError.value = null;
		try {
			const a = await correctSemSetting(api, id, key, parsed.value);
			if (id !== fileId()) return;
			answer.value = a;
			editing.value = null;
		} catch (e) {
			if (id !== fileId()) return;
			if (e instanceof InboxApiError && e.status === 403) {
				fieldError.value = { key, text: ONLY_OWNER_TEXT };
				const d = data.value;
				if (d) answer.value = { ...d, locked: false, can_edit: false };
				editing.value = null;
			} else {
				fieldError.value = { key, text: e instanceof Error && e.message ? e.message : 'Could not save that.' };
			}
		} finally {
			saving.value = false;
		}
	}

	return { answer, state, rows, canEdit, error, editing, draft, saving, fieldError, load, start, cancel, save, cancelPending: () => gate.cancel() };
}
