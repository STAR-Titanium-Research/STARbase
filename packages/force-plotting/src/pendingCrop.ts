// A shared link's crop-preview window has to survive until the live cache of ITS operation has
// parsed: onCloudLoaded re-seeds the crop handles from the saved/cache crop at that point, which
// would otherwise erase a crop that applyViewState set earlier. The request is therefore keyed by
// operation id and consumed only by the load of that same operation.

export type CropWindow = [number, number];

export function createPendingCrop() {
	let pending: { opId: string; crop: CropWindow } | null = null;
	return {
		/** Remember a requested crop for an operation (replacing any earlier request). */
		set(opId: string, crop: CropWindow) { pending = { opId, crop }; },
		/** The crop to apply now for this operation, without consuming it, or null. */
		peek(opId: string | null | undefined): CropWindow | null {
			return pending && opId && pending.opId === opId ? pending.crop : null;
		},
		/** The crop to apply when this operation's cache has loaded; clears the request. A load of
		 *  a different operation drops it too (the request can no longer apply). */
		take(opId: string | null | undefined): CropWindow | null {
			const hit = pending && opId && pending.opId === opId ? pending.crop : null;
			pending = null;
			return hit;
		},
		clear() { pending = null; },
		get active() { return pending !== null; },
	};
}
