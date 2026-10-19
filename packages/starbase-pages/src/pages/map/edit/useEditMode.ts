// Edit mode of the Process map as one composable (spec §7.1): reads `edit` from the address (`edit=new` starts a draft and
// replaces the address with `edit=<id>`; `edit=<id>` opens one of my drafts), wraps useDraft, merges the draft into the
// loaded data with toGraph (the page hands the map this as its overlay), and keeps what the canvas and the lid need: whether
// edit mode exists here at all (`available`: d1-build answered), whether building is possible (not on a phone), and which
// draft item is selected. Provided to the page's children with provide/inject (EDIT_MODE_KEY).
//
// A draft opened on a phone is shown but not editable (E20): `drafted` (the draft is on the map) is true there, `editing` is not.

import { computed, inject, onScopeDispose, provide, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { DraftBody, DraftKey, DraftListEntry, FieldDef as DirectusField, HostApi } from '@d1/ui';
import type { MapNode, ProcessData } from '../model/types';
import type { MergeHint } from '../useMapExpand';
import type { MapOverlay, MapRoute, MapRouter } from '../useProcessMap';
import { blocking } from './checks';
import type { DraftAction, WorkState } from './draft';
import { draftKeyOfNode, isDraftNode } from './socketRefs';
import { defaultName, isoDay, summaryText } from './summary';
import { toGraph, type ToGraphCtx } from './toGraph';
import { useDraft, type DraftApi } from './useDraft';
import { useEditCatalog, type EditCatalog } from './useEditCatalog';
import { workStateActions } from './workState';

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

/** What the map panel says when the address asks for edit mode and this server has no d1-build (the view-only map keeps working). */
export const UNAVAILABLE = "Building processes isn't available on this server yet.";

/** What the page says when the server refuses the account (403: it may not create operations): a plain notice, not an error. */
export const FORBIDDEN = 'Your account may not build processes.';

/** The two plain notices (this server cannot build, this account may not): said as a status, not as an error. */
export const isNotice = (text: string): boolean => text === UNAVAILABLE || text === FORBIDDEN;

/** What the page says when a draft's last changes are not on the server yet (so leaving would lose them). */
export const NOT_KEPT = 'Your last changes are not kept yet. Fix the connection and try again, or keep editing.';
/** What the page says when `edit=new` is opened on a phone. */
export const PHONE_NEW = 'Building needs a screen at least 768 px wide.';

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
	/** The toggle is offered: d1-build is there (or could not be asked, which the next try may fix) and the window is wide enough. */
	const canBuild = computed(() => !o.isPhone.value && (available.value || !!draft.probeError.value));
	/** Everything the person did is on the server (nothing waiting, nothing failed): leaving the draft loses nothing. */
	const kept = (): boolean => !draft.saving.value && !draft.saveError.value;

	const body = draft.body;
	const checks = draft.checks;
	const missing = draft.missing;

	// ---- the draft as the address asks for it ----------------------------------------------------
	let starting = false;
	let alive = true;
	async function sync(): Promise<void> {
		const p = param.value;
		if (p && failed.value && !draft.draftId.value && !starting) failed.value = '';
		if (!p) {
			// Edit mode ended (Done editing, Create, the back button): the draft stays on the server, the page lets go of it, unless
			// the server does not have the last changes yet: then they are kept in the page (the next open of the draft saves them).
			if (draft.draftId.value) {
				await draft.flush().catch(() => undefined);
				if (kept()) {
					// A draft with nothing in it was only the toggle: it is not left behind on the server.
					if (isEmptyBody(draft.body.value)) await draft.discard();
					else draft.forget();
				} else failed.value = NOT_KEPT;
			}
			return;
		}
		if (!draft.probed.value) return;
		if (!draft.available.value) {
			// A server without d1-build (404) is a plain notice; a probe that failed any other way says why (the Edit toggle asks again).
			failed.value = draft.probeError.value || (draft.forbidden.value ? FORBIDDEN : UNAVAILABLE);
			writeQuery({ edit: null });
			return;
		}
		if (p === 'new') {
			if (o.isPhone.value) {
				failed.value = PHONE_NEW;
				writeQuery({ edit: null });
				return;
			}
			// Build a process while a draft with nothing in it is open: that one is the new draft (none is left behind on the server).
			if (draft.draftId.value && !starting && isEmptyBody(draft.body.value)) {
				writeQuery({ edit: draft.draftId.value });
				return;
			}
			if (starting) return;
			starting = true;
			try {
				const id = await draft.start();
				if (id && (!alive || param.value !== 'new')) {
					// The address moved on (the back button, another draft) while the draft was being made: nothing is left behind.
					await draft.discard();
				} else if (id) writeQuery({ edit: id });
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
	// The page goes away with a draft open and empty (a route change, not the lid): it is not left on the server.
	onScopeDispose(() => {
		alive = false;
		if (draft.draftId.value && isEmptyBody(draft.body.value) && kept()) void draft.discard().catch(() => undefined);
	});
	// The changes that were not kept are kept after all (the connection came back): the message goes.
	watch(kept, (ok) => {
		if (ok && failed.value === NOT_KEPT) failed.value = '';
	});

	// ---- the lid -----------------------------------------------------------------------------------
	/** Edit toggle: starts a draft on the map being looked at (the history is extended, not copied). */
	async function startEditing(): Promise<void> {
		if (!canBuild.value || param.value) return;
		// The probe failed earlier (not a 404): ask again before giving up on building.
		if (!available.value && !(await draft.probe())) {
			failed.value = draft.probeError.value || (draft.forbidden.value ? FORBIDDEN : UNAVAILABLE);
			return;
		}
		failed.value = '';
		writeQuery({ edit: 'new' });
	}
	/** Open ▾: one of my drafts. The map's own focus is left: a draft stands on its own cards. */
	async function openDraft(id: string): Promise<void> {
		if (id === param.value) return;
		await draft.flush().catch(() => undefined);
		// Opening another draft would drop what the server does not have yet.
		if (!kept()) {
			failed.value = NOT_KEPT;
			return;
		}
		failed.value = '';
		writeQuery({ edit: id, focus: null });
	}
	/** Done editing: back to the map. An empty draft is discarded (it was only the toggle); one with something in it is kept. */
	async function done(patch: Record<string, string | null> = {}): Promise<void> {
		failed.value = '';
		await draft.flush().catch(() => undefined);
		// Leaving would lose what the server does not have: stay, and say so.
		if (!kept()) {
			failed.value = NOT_KEPT;
			return;
		}
		if (isEmptyBody(draft.body.value) && !(await draft.discard())) {
			failed.value = draft.saveError.value || 'Could not discard the empty draft.';
			return;
		}
		writeQuery({ edit: null, ...patch });
	}
	/** Throws the open draft away for good and leaves edit mode. */
	async function discardDraft(): Promise<void> {
		await draft.discard();
		writeQuery({ edit: null });
	}

	// ---- changing the draft ---------------------------------------------------------------------------
	/** Does one action, or several as one undoable step; the canvas lays out only what is new, beside `anchor` when there is a card the change grew out of. */
	function apply(action: DraftAction | DraftAction[], opts: { anchor?: string; merge?: boolean; keepFuture?: boolean } = {}): DraftBody {
		if (!editing.value) return draft.body.value;
		if (!opts.merge) typing = null;
		const before = draft.body.value;
		const o2 = opts.merge ? { merge: true, ...(opts.keepFuture ? { keepFuture: true } : {}) } : undefined;
		const next = Array.isArray(action) ? draft.applyAll(action, o2) : draft.apply(action, o2);
		if (next !== before) o.hint?.({ anchor: opts.anchor });
		return next;
	}

	/** Keys typed in one field of one item within this long are one undo step. */
	const TYPING_MS = 1500;
	let typing: { key: DraftKey; fields: string; at: number } | null = null;
	/** The same value, as the draft compares them (a cleared field is `undefined`, `null` or absent). */
	const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	/**
	 * The form's change of an item's values: successive changes to the same field of the same item are folded into one step while the person
	 * types. The form hands over every value the item has, so what changed is worked out against the draft: a change to another field of
	 * the same card is a step of its own (undo takes back one field at a time).
	 */
	function setValues(key: DraftKey, values: Record<string, unknown>): void {
		const now = Date.now();
		const item = draft.body.value.items.find((i) => i.key === key);
		const changed = Object.keys(values).filter((k) => !sameValue(item?.values[k], values[k]));
		// Nothing that is not already there: the reducer treats it as no change, and the step being typed in stays open.
		if (!changed.length) return;
		const fields = changed.sort().join(',');
		const merge = !!typing && typing.key === key && typing.fields === fields && now - typing.at < TYPING_MS;
		apply({ type: 'setValues', key, values }, { merge });
		typing = { key, fields, at: now };
	}
	/**
	 * Planned or done at Create for new operations or tests (R9): the state, and for Done the date it happened, as ONE undoable step whether the
	 * rail's toggle or the card's chip asks. Several keys (a stack of passes) are one step too.
	 */
	function setWorkState(keys: DraftKey | DraftKey[], state: WorkState): void {
		const actions = (Array.isArray(keys) ? keys : [keys]).flatMap((k) => {
			const item = draft.body.value.items.find((i) => i.key === k);
			return item ? workStateActions(item, state) : [];
		});
		if (actions.length) apply(actions);
	}
	function undo(): void {
		if (!editing.value) return;
		typing = null;
		draft.undo();
		o.hint?.({});
	}
	function redo(): void {
		if (!editing.value) return;
		typing = null;
		draft.redo();
		o.hint?.({});
	}

	// ---- what the draft needs read ----------------------------------------------------------------------
	watch(
		() => editing.value || drafted.value,
		(on) => on && void catalog.ensure(),
		{ immediate: true },
	);
	const unreadable = new Set<string>();
	watch(
		() => draft.draftId.value,
		() => {
			unreadable.clear();
			catalog.forgetFailed();
		},
	);
	// The existing records of the draft (its samples with their cards, the rest with their versions) and the materials its codes are made of.
	watch(
		() => draft.body.value.items,
		(items) => {
			if (!drafted.value) return;
			const want = catalog.existingIds(items);
			const unknown = want.physical_samples.filter((id) => !catalog.samples.has(id) && !unreadable.has(id));
			// A sample that could not be read is not asked for again on every change of the draft (opening another draft tries again).
			if (unknown.length) {
				void catalog
					.loadSamples(unknown)
					.then((read) => unknown.forEach((id) => read.has(id) || unreadable.add(id)))
					.catch(() => unknown.forEach((id) => unreadable.add(id)));
			}
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
		apply, setValues, setWorkState, undo, redo, writeQuery,
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
