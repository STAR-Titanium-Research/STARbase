// Everything edit mode puts beside the map, assembled for the page (the page keeps to the map): the canvas interactions (useEditSurface),
// Create and what follows (useCreate), Mark done (useMarkDone), and what the rail's edit sections ask of the page (provided to them).
// Mark done is here too because it works in view mode and on a phone.

import { provide, type Ref } from 'vue';
import { dataStudioRoute, type ExplorerHost, type FormField } from '@d1/ui';
import { MAP_EDIT } from '../nodes/actions';
import type { useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { collectionOf } from './checks';
import { EDIT_RAIL_KEY } from './railContext';
import { useCreate } from './useCreate';
import type { EditMode } from './useEditMode';
import { useEditSurface } from './useEditSurface';
import { useMarkDone } from './useMarkDone';

export function useEditSide(o: { host: Pick<ExplorerHost, 'openDataStudio' | 'user'>; edit: EditMode; map: ReturnType<typeof useProcessMap>; canvas: ReturnType<typeof useMapCanvas>; canvasEl: Ref<HTMLElement | null>; /** The page has the Finder open: the edit keys leave the keyboard to it. */ finderOpen?: () => boolean }) {
	const { host, edit } = o;
	const markDone = useMarkDone({ edit, map: o.map });
	const build = useEditSurface({ ...o, blockedBy: () => markDone.open.value || !!o.finderOpen?.(), person: () => host.user.value?.id });
	provide(MAP_EDIT, build.mapEdit);
	const create = useCreate({ edit, map: o.map, select: build.selectKey });
	provide(EDIT_RAIL_KEY, {
		labelFor: build.labelForKey,
		select: build.selectKey,
		showMissing: create.showMissing,
		saveTemplate: { can: build.templateUi.canSaveSelected, open: () => void build.templateUi.openSelected() },
		// A field the form cannot draw: Data Studio draws it, once there is a record to open. A new item's form says so in place of the
		// link ("Opens in Data Studio after Create", item 12), so nothing is asked here for one.
		openExternal: (key: string, _field: FormField) => {
			const item = edit.body.value.items.find((i) => i.key === key);
			if (item?.existing) host.openDataStudio(dataStudioRoute(collectionOf(item), item.existing.id));
		},
	});
	return { build, create, markDone };
}

export type EditSide = ReturnType<typeof useEditSide>;
