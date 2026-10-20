// What the rail's edit sections ask of the page above them (provide/inject, so MapRail, which is drawn in two places, needs no props
// for it): the name of a draft card, selecting a card from Checks, a field the form cannot draw, and whether to mark every empty required field.

import { inject, type InjectionKey, type Ref } from 'vue';
import type { FormField } from '@d1/ui';

export interface EditRailContext {
	/** A draft card called by what the canvas calls it ("PS-001", "Turning"). */
	labelFor(key: string): string;
	/** Selects the card (and brings it into view). */
	select(key: string): void;
	/** A field the form cannot draw: open the record in Data Studio when it exists. */
	openExternal(key: string, field: FormField): void;
	/** After a Create that was refused: mark what is missing, not only what has been touched. */
	showMissing: Ref<boolean>;
}

export const EDIT_RAIL_KEY: InjectionKey<EditRailContext> = Symbol('editRail');

export const useEditRail = (): EditRailContext | null => inject(EDIT_RAIL_KEY, null);
