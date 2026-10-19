// What the page does with templates besides listing them (redesign R7): "Save as template" on the selected container (the rail's button, the
// card's right-click menu), and the palette's manage actions (rename, who sees it, replace with the selected card's settings, delete).
// The selected container can be one of the draft or a recorded operation or test of the map: a recorded one is read first (it is not in the
// draft), and what is saved is what it stands as. The values come from `templateValuesOf`; the server is `useTemplates`.

import { computed, ref, shallowRef, watch, type ComputedRef } from 'vue';
import type { DraftItem } from '@d1/ui';
import type { ContainerNode } from '../model/types';
import type { useProcessMap } from '../useProcessMap';
import { recordKey, type CheckCollection } from './checks';
import { draftKeysOfNode } from './socketRefs';
import { templateCollectionOf, templateProblem, templateValuesOf, type TemplateCollection, type TemplateScope } from './templates';
import type { EditMode } from './useEditMode';
import type { Templates } from './useTemplates';

type ProcessMap = ReturnType<typeof useProcessMap>;

/** The dialog's state: what is being saved and what it would keep. */
export interface SaveState {
	what: 'operation' | 'test';
	collection: TemplateCollection;
	/** What the name starts as. */
	name: string;
	/** The values without the notes, and with them (the dialog's tick picks). */
	values: Record<string, unknown>;
	valuesWithNotes: Record<string, unknown>;
	/** The labels of the fields kept. */
	labels: string[];
	hasNotes: boolean;
	/** The record it was made from is restricted: only a private template may be made from it. */
	restricted: boolean;
	problem: string | null;
	error: string;
	busy: boolean;
}

/** What a container offers to a template: its collection and the values it would keep (the notes apart), or why not. */
interface Taken {
	what: 'operation' | 'test';
	collection: TemplateCollection;
	name: string;
	values: Record<string, unknown>;
	valuesWithNotes: Record<string, unknown>;
	labels: string[];
	restricted: boolean;
	problem: string | null;
}

const RECORDED_READ = 'Could not read that record. Try again in a moment.';
/** What is said when a restricted record would go into a template others can see (ADR-0011: its parameters are not for everyone). */
export const RESTRICTED_TEXT = 'This record is restricted, so a template made from it can only be for Only me.';

export function useTemplateUi(o: { edit: EditMode; templates: Templates; map: ProcessMap; /** Opens the palette: a template just saved is in it. */ openPalette: () => void }) {
	const { edit, map, templates } = o;
	const saving = shallowRef<SaveState | null>(null);
	/** A line the palette says after a change ("Saved the template Roughing."); the templates' own failures are `templates.error`. */
	const notice = ref('');

	// The machine, tool or edge a new card names (typed, or brought by a template): Checks warns when it is retired or used up.
	watch(
		() => edit.body.value.items,
		(items) => void (edit.drafted.value && edit.catalog.gear.ensure(items.filter((i) => !i.existing).map((i) => i.values))),
		{ immediate: true },
	);

	/** The container the person has selected on the map (a draft's or a recorded one), or null. */
	const selectedContainer: ComputedRef<ContainerNode | null> = computed(() => {
		const n = map.graph.value?.nodes.find((x) => x.id === map.selectedId.value);
		return n?.type === 'container' ? n : null;
	});
	/** Edit mode with a container selected: Save as template is offered. */
	const canSaveSelected = computed(() => edit.editing.value && !!selectedContainer.value);
	/** What the selected container is, for the palette's "Replace with…". */
	const selectedKind = computed(() => (edit.editing.value ? (selectedContainer.value?.kind ?? null) : null));

	const labelOf = (collection: CheckCollection, field: string): string => edit.catalog.checkFields.value[collection]?.find((d) => d.field === field)?.label ?? field.replace(/_/g, ' ');
	const defsOf = (collection: CheckCollection) => edit.catalog.rawFields.value[collection] ?? [];

	/** The name a container has on the canvas: its method or test type. */
	function nameOf(item: DraftItem, values: Record<string, unknown>): string {
		if (item.kind === 'operation') return edit.catalog.methodById.value.get(String(values.method_id))?.name ?? '';
		const type = String(values.test_type ?? '');
		return edit.catalog.testTypes.value.find((t) => t.value === type)?.name ?? type;
	}

	/** What `item` would save (a recorded one is read first). */
	async function take(item: DraftItem | null, node?: ContainerNode | null): Promise<Taken | null> {
		let it = item;
		// A recorded container that is not in the draft: a stand-in item over its first row's record.
		if (!it && node) {
			const id = node.group.rowIds[0];
			if (!id) return null;
			it = { key: node.id, kind: node.kind, workState: 'done', existing: { id, version: 0 }, values: {}, rows: [] } as unknown as DraftItem;
		}
		const collection = templateCollectionOf(it);
		if (!it || !collection) return null;
		const c = collection as CheckCollection;
		let loaded: Record<string, unknown> | undefined;
		if (it.existing) {
			const key = recordKey(c, it.existing.id);
			await edit.catalog.loadRecords({ physical_samples: [], manufacturing_operations: c === 'manufacturing_operations' ? [it.existing.id] : [], test_sessions: c === 'test_sessions' ? [it.existing.id] : [] }, { retry: true });
			loaded = edit.catalog.records.get(key)?.values;
			if (!loaded) return { what: it.kind as 'operation' | 'test', collection, name: '', values: {}, valuesWithNotes: {}, labels: [], restricted: false, problem: RECORDED_READ };
		}
		const values = templateValuesOf(it, loaded, defsOf(c));
		const valuesWithNotes = templateValuesOf(it, loaded, defsOf(c), { notes: true });
		return {
			what: it.kind as 'operation' | 'test',
			collection,
			name: nameOf(it, values),
			values,
			valuesWithNotes,
			labels: Object.keys(values).filter((k) => k !== 'process_category').map((k) => labelOf(c, k)),
			restricted: loaded?.restricted === true,
			problem: templateProblem(it, values),
		};
	}

	const draftItemOf = (key: string): DraftItem | null => edit.body.value.items.find((i) => i.key === key) ?? null;
	/** The item of the draft a container card is made of (the first, for a stack of passes), if it is in the draft. */
	const draftItemOfNode = (node: ContainerNode): DraftItem | null => {
		const keys = draftKeysOfNode(edit.body.value, node);
		return keys.length ? draftItemOf(keys[0]) : null;
	};

	// ---- Save as template ----------------------------------------------------------------------------------
	/** Opens the dialog for the selected container (its rail button, its right-click menu, ...). */
	async function openSelected(): Promise<boolean> {
		const node = selectedContainer.value;
		if (!edit.editing.value || !node) return false;
		const t = await take(draftItemOfNode(node), node);
		if (!t) return false;
		saving.value = { what: t.what, collection: t.collection, name: t.name, values: t.values, valuesWithNotes: t.valuesWithNotes, labels: t.labels, hasNotes: Object.keys(t.valuesWithNotes).length > Object.keys(t.values).length, restricted: t.restricted, problem: t.problem, error: '', busy: false };
		return true;
	}
	const closeSave = (): void => void (saving.value = null);
	async function save(v: { name: string; scope: TemplateScope; notes: boolean }): Promise<void> {
		const s = saving.value;
		if (!s || s.busy) return;
		if (s.restricted && v.scope !== 'private') {
			saving.value = { ...s, error: RESTRICTED_TEXT };
			return;
		}
		saving.value = { ...s, busy: true, error: '' };
		const r = await templates.create({ name: v.name, scope: v.scope, collection: s.collection, values: v.notes ? s.valuesWithNotes : s.values });
		if (!saving.value) return;
		if (r.ok) {
			saving.value = null;
			notice.value = `Saved the template ${v.name}.`;
			o.openPalette();
		} else saving.value = { ...saving.value, busy: false, error: r.message };
	}

	// ---- the palette's manage actions ----------------------------------------------------------------------
	/** Said when something worked, cleared when something else is done. */
	const say = (text: string): void => void (notice.value = text);
	async function rename(id: string, name: string): Promise<boolean> {
		const r = await templates.rename(id, name);
		if (r.ok) say(`Renamed the template ${name}.`);
		return r.ok;
	}
	async function setScope(id: string, scope: TemplateScope): Promise<boolean> {
		const r = await templates.setScope(id, scope);
		if (r.ok) say('Changed who can use the template.');
		return r.ok;
	}
	async function remove(id: string): Promise<boolean> {
		const name = templates.rows.value.find((t) => t.id === id)?.name ?? 'the template';
		const r = await templates.remove(id);
		if (r.ok) say(`Deleted the template ${name}. What was made from it is unchanged.`);
		return r.ok;
	}
	/** "Replace with the selected card's settings": the template takes the values of the selected container of the same kind. */
	async function replace(id: string): Promise<boolean> {
		const t = templates.rows.value.find((x) => x.id === id);
		const node = selectedContainer.value;
		if (!t || !node) return false;
		if ((node.kind === 'operation') !== (t.collection === 'manufacturing_operations')) {
			templates.error.value = `Select ${t.collection === 'manufacturing_operations' ? 'an operation' : 'a test'} to replace this template with.`;
			return false;
		}
		const taken = await take(draftItemOfNode(node), node);
		if (!taken || taken.problem) {
			templates.error.value = taken?.problem ?? 'That card cannot be saved as a template.';
			return false;
		}
		if (taken.restricted && t.scope !== 'private') {
			templates.error.value = RESTRICTED_TEXT;
			return false;
		}
		const r = await templates.replaceValues(id, taken.values);
		if (r.ok) say(`Replaced the settings of ${t.name} with those of ${node.title || 'the selected card'}.`);
		return r.ok;
	}

	/** What the palette draws and does for templates, to bind in one go. */
	const paletteProps = computed(() => ({
		templateNotice: templates.error.value || notice.value,
		templateFailed: !!templates.error.value,
		templateBusy: templates.busy.value,
		/** The kind of the selected container (or null): the palette offers Replace only for a template of that kind. */
		selectedKind: selectedKind.value,
		selectedTitle: selectedContainer.value?.title ?? '',
	}));
	const paletteEvents = {
		'template-rename': (id: string, name: string) => void rename(id, name),
		'template-scope': (id: string, scope: TemplateScope) => void setScope(id, scope),
		'template-replace': (id: string) => void replace(id),
		'template-delete': (id: string) => void remove(id),
		'template-dismiss': () => {
			templates.dismiss();
			notice.value = '';
		},
	};

	/** The drawn card that is selected (where focus goes back to when the dialog closes). */
	const selectedNodeId = computed(() => map.selectedId.value ?? null);

	return { saving, notice, selectedNodeId, canSaveSelected, selectedKind, openSelected, closeSave, save, rename, setScope, remove, replace, paletteProps, paletteEvents };
}

export type TemplateUi = ReturnType<typeof useTemplateUi>;
