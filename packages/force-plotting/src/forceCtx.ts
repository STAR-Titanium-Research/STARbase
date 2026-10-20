// The dashboard's state, shared with the panels and tabs it is split into (the operation column's tabs, the
// Signals and FRM panels, the Metadata doctor). They all read and edit the same selection, cut parameters,
// filter chain and crop, so instead of forty props each, ForceDashboard provides one reactive bundle of its
// refs, computeds and functions and a panel takes what it uses:
//
//   const { detail, liveOn, editFeed } = useForceCtx();
//
// The members are refs (or functions), so `v-model="editFeed"` writes straight back to the dashboard's own
// ref; in a script they need `.value`, in a template they unwrap.

import { inject, toRefs, type InjectionKey, type ToRefs } from 'vue';

export type ForceCtx = Record<string, any>;
export const FORCE_CTX: InjectionKey<ForceCtx> = Symbol('force-dashboard');

export function useForceCtx(): ToRefs<ForceCtx> {
	const ctx = inject(FORCE_CTX);
	if (!ctx) throw new Error('useForceCtx() needs a ForceDashboard above it');
	return toRefs(ctx);
}
