// Edit mode of the Process map as one composable (spec §7.1): reads `edit` from the address (`edit=new` starts a draft and
// replaces the address with `edit=<id>`; `edit=<id>` opens one of my drafts), wraps useDraft, merges the draft into the
// loaded data with toGraph (the page hands the map this as its overlay), and keeps what the canvas and the lid need: whether
// edit mode exists here at all (`available`: d1-build answered), whether building is possible (not on a phone), and which
// draft item is selected. Provided to the page's children with provide/inject (EDIT_MODE_KEY).
//
// A draft opened on a phone is shown but not editable (E20): `drafted` (the draft is on the map) is true there, `editing` is not.

import { computed, inject, provide, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { DraftBody, DraftKey, DraftListEntry, FieldDef as DirectusField, HostApi } from '@d1/ui';
import type { MapNode, ProcessData } from '../model/types';
import type { MapOverlay, MapRoute, MapRouter, MergeHint } from '../useProcessMap';
import { blocking } from './checks';
import type { DraftAction } from './draft';
import { draftKeyOfNode, isDraftNode } from './socketRefs';
import { defaultName, isoDay, summaryText } from './summary';
import { toGraph, type ToGraphCtx } from './toGraph';
import { useDraft, type DraftApi } from './useDraft';
import { useEditCatalog, type EditCatalog } from './useEditCatalog';

export interface EditModeOptions {
	api: HostApi;
	fieldsFor: (collection: string) => Promise<DirectusField[]>;
	route: MapRoute;
	router: MapRouter;
	/** Below 768 px: no building (E20). */
	isPhone: Ref<boolean>;
	/** The record the map is opened on, when there is one: a blank canvas has none. */
	focus: () => { collection: string; id: string } | null;
	/** The code of the focus record, for the name a new draft gets. */
	focusCode?: () => string | undefined;
	/** The card the rail shows, to tell which draft item is selected. */
	selected?: () => MapNode | undefined;
	/** Tells the canvas what kind of change a draft action made, so only the new cards are laid out (the map's hintMerge). */
	hint?: (h: MergeHint) => void;
}

const first = (v: unknown): string | undefined => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : undefined);

/** A draft with nothing in it is not worth keeping when edit mode ends. */
export const isEmptyBody = (b: DraftBody): boolean => b.items.length === 0;

export function useEditMode(o: EditModeOptions) {
	const catalog = useEditCatalog(o.api, o.fieldsFor);
	const draft = useDraft({
		api: o.api,
		ctx: () => catalog.ctx(),
		nameFor: (body) => (o.focusCode?.() ? `${o.focusCode!()} · ${isoDay(new Date())}` : defaultName(body)),
	});

	// ---- the address ---------------------------------------------------------------------------
	const param = computed(() => first(o.route.query.edit));

	/** The address with `patch` applied to its query (a null value takes the key away), the page's own path. */
	function writeQuery(patch: Record<string, string | null>): void {
		const query: Record<string, string> = {};
		for (const [k, v] of Object.entries(o.route.query)) {
			const s = first(v);
			if (s !== undefined && k !== 'sample') query[k] = s;
		}
		const focus = o.focus();
		if (focus && !query.focus) query.focus = `${focus.collection}:${focus.id}`;
		for (const [k, v] of Object.entries(patch)) {
			if (v === null) delete query[k];
			else query[k] = v;
		}
		void o.router.replace({ path: o.route.path, query });
	}

	// ---- what is on, and what can be done -------------------------------------------------------
	/** Why an `edit` in the address could not be opened (said once by the page). */
	const failed = ref('');
	/** d1-build answered: false while unknown and for good when this server has none (the Edit toggle and Build a process stay hidden). */
	const available = computed(() => draft.available.value);
	/** The draft in the address is open, so it is on the map. */
	const drafted = computed(() => !!param.value && draft.available.value && draft.draftId.value === param.value);
	/** The draft is on the map and can be changed. */
	const editing = computed(() => drafted.value && !o.isPhone.value);
	/** An `edit` in the address that is not open yet (the probe, the start or the read of the draft is on its way): the page shows "loading". */
	const pending = computed(() => !!param.value && !drafted.value && !failed.value && (!draft.probed.value || draft.available.value));
	/** The toggle is offered: d1-build is there and the window is wide enough. */
	const canBuild = computed(() => available.value && !o.isPhone.value);

	const body = draft.body;
	const checks = draft.checks;
	const missing = draft.missing;

	// ---- the draft as the address asks for it ----------------------------------------------------
	let starting = false;
	async function sync(): Promise<void> {
		const p = param.value;
		if (p && failed.value && !draft.draftId.value && !starting) failed.value = '';
		if (!p) {
			// Edit mode ended (Done editing, Create, the back button): the draft stays on the server, the page lets go of it.
			// (`failed` is kept: it is the reason edit mode ended, and the page says it.)
			if (draft.draftId.value) {
				await draft.flush().catch(() => undefined);
				draft.forget();
			}
			return;
		}
		if (!draft.probed.value) return;
		if (!draft.available.value) {
			failed.value = 'Edit mode is not available on this server.';
			writeQuery({ edit: null });
			return;
		}
		if (p === 'new') {
			if (o.isPhone.value) {
				writeQuery({ edit: null });
				return;
			}
			if (starting) return;
			starting = true;
			try {
				const id = await draft.start();
				if (id) writeQuery({ edit: id });
				else {
					failed.value = draft.saveError.value || 'Could not start a draft.';
					writeQuery({ edit: null });
				}
			} finally {
				starting = false;
			}
			return;
		}
		if (draft.draftId.value === p) return;
		failed.value = '';
		if (!(await draft.open(p))) {
			failed.value = draft.saveError.value || 'That draft is not there any more.';
			writeQuery({ edit: null });
		}
	}
	watch([param, () => draft.probed.value, () => o.isPhone.value], () => void sync(), { immediate: true });
	void draft.probe();

	// ---- the lid -----------------------------------------------------------------------------------
	/** Edit toggle: starts a draft on the map being looked at (the history is extended, not copied). */
	function startEditing(): void {
		if (!canBuild.value || param.value) return;
		writeQuery({ edit: 'new' });
	}
	/** Open ▾: one of my drafts. The map's own focus is left: a draft stands on its own cards. */
	function openDraft(id: string): void {
		if (id === param.value) return;
		void draft.flush().catch(() => undefined);
		writeQuery({ edit: id, focus: null });
	}
	/** Done editing: back to the map. An empty draft is discarded (it was only the toggle); one with something in it is kept. */
	async function done(patch: Record<string, string | null> = {}): Promise<void> {
		await draft.flush().catch(() => undefined);
		if (isEmptyBody(draft.body.value)) await draft.discard();
		writeQuery({ edit: null, ...patch });
	}
	/** Throws the open draft away for good and leaves edit mode. */
	async function discardDraft(): Promise<void> {
		await draft.discard();
		writeQuery({ edit: null });
	}

	// ---- changing the draft ---------------------------------------------------------------------------
	/** Does one action, or several as one undoable step; the canvas lays out only what is new, beside `anchor` when there is a card the change grew out of. */
	function apply(action: DraftAction | DraftAction[], opts: { anchor?: string } = {}): DraftBody {
		if (!editing.value) return draft.body.value;
		const before = draft.body.value;
		const next = Array.isArray(action) ? draft.applyAll(action) : draft.apply(action);
		if (next !== before) o.hint?.({ anchor: opts.anchor });
		return next;
	}
	function undo(): void {
		if (!editing.value) return;
		draft.undo();
		o.hint?.({});
	}
	function redo(): void {
		if (!editing.value) return;
		draft.redo();
		o.hint?.({});
	}

	// ---- what the draft needs read ----------------------------------------------------------------------
	watch(
		() => editing.value || drafted.value,
		(on) => on && void catalog.ensure(),
		{ immediate: true },
	);
	// The existing records of the draft (its samples with their cards, the rest with their versions) and the materials its codes are made of.
	watch(
		() => draft.body.value.items,
		(items) => {
			if (!drafted.value) return;
			const want = catalog.existingIds(items);
			const unknown = want.physical_samples.filter((id) => !catalog.samples.has(id));
			if (unknown.length) void catalog.loadSamples(unknown).catch(() => undefined);
			void catalog.loadRecords({ ...want, physical_samples: [] });
			void catalog.ensureMaterials(items.map((i) => i.values.material_id).filter((v): v is string => typeof v === 'string'));
		},
		{ immediate: true },
	);
	watch(
		() => [...catalog.records.values()].map((r) => r?.values.material_id),
		(ids) => void catalog.ensureMaterials(ids.filter((v): v is string => typeof v === 'string')),
	);

	// ---- the draft on the map ------------------------------------------------------------------------------
	const mergeCtx = computed<ToGraphCtx>(() => ({
		...catalog.ctx(),
		samples: Object.fromEntries(catalog.samples),
		methods: Object.fromEntries(catalog.methods.value.map((m) => [m.id, { name: m.name, category: m.category }])),
		testTypes: Object.fromEntries(catalog.testTypes.value.map((t) => [t.value, { name: t.name, category: null }])),
		label: (collection, id) => (collection === 'physical_samples' ? catalog.samples.get(id)?.code : undefined),
	}));
	const overlay: MapOverlay = {
		active: () => drafted.value,
		blank: () => drafted.value && !o.focus(),
		merge: (data: ProcessData | null) => toGraph(data, draft.body.value, mergeCtx.value),
		keep: (n: MapNode) => isDraftNode(draft.body.value, n),
	};

	// ---- the selected draft item -------------------------------------------------------------------------------
	const selectedKey: ComputedRef<DraftKey | null> = computed(() => (drafted.value ? draftKeyOfNode(draft.body.value, o.selected?.()) : null));
	const selectedItem = computed(() => (selectedKey.value ? (draft.body.value.items.find((i) => i.key === selectedKey.value) ?? null) : null));

	// ---- what the lid says --------------------------------------------------------------------------------------
	const summary = computed(() => summaryText(draft.body.value));
	const blockers = computed(() => blocking(checks.value));

	const api = {
		catalog,
		draft: draft as DraftApi,
		overlay,
		// state
		available, drafted, editing, pending, canBuild, failed, isPhone: o.isPhone, param,
		body, checks, missing, blockers, summary,
		selectedKey, selectedItem,
		drafts: draft.drafts as Ref<DraftListEntry[]>,
		// the lid
		startEditing, openDraft, done, discardDraft,
		// changing
		apply, undo, redo, writeQuery,
		refreshDrafts: draft.refresh,
	};
	return api;
}

export type EditMode = ReturnType<typeof useEditMode>;

export const EDIT_MODE_KEY: InjectionKey<EditMode> = Symbol('editMode');

/** Provides edit mode to the page's children. */
export function provideEditMode(e: EditMode): void {
	provide(EDIT_MODE_KEY, e);
}

/** The edit mode of the page above, or null where there is none (a card drawn on its own). */
export function useEditModeInjected(): EditMode | null {
	return inject(EDIT_MODE_KEY, null);
}

export type { EditCatalog };
