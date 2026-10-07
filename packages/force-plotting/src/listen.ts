// addEventListener that hands back its own remover. An anonymous handler passed straight to
// addEventListener can never be removed, so every mount of the component leaked one on `document`
// (review 3.7); keeping the disposer next to the registration makes the unmount hook a one-liner.
export function listen(target: EventTarget, type: string, handler: (ev: Event) => void, opts?: AddEventListenerOptions): () => void {
	target.addEventListener(type, handler, opts);
	return () => target.removeEventListener(type, handler, opts);
}
