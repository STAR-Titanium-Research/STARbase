// Trailing-edge debounce with an explicit cancel, so a component can drop a pending call on unmount.
export interface Debounced {
	(): void;
	cancel(): void;
	readonly pending: boolean;
}

export function debounce(fn: () => void, ms: number): Debounced {
	let t: ReturnType<typeof setTimeout> | null = null;
	const d = (() => {
		if (t) clearTimeout(t);
		t = setTimeout(() => { t = null; fn(); }, ms);
	}) as Debounced;
	d.cancel = () => { if (t) clearTimeout(t); t = null; };
	Object.defineProperty(d, 'pending', { get: () => t !== null });
	return d;
}
