// Point the operator at one control: scroll it to the middle of its scroll container and ring it
// for a couple of seconds. Used wherever the app knows WHICH field is wrong — e.g. /record/start
// refusing a sample rate the NI-DAQ hardware can't do (#84) — so the message isn't left for the
// operator to map back onto the form by themselves.
//
// The ring itself is pure CSS (`.spotlight` in styles.css): an expanding pulse normally, a static
// outline under prefers-reduced-motion. A target is either an element or a `data-focus` id, so a
// caller (or a `?focus=` link) can name a control without holding a ref to it:
//
//     <StatTile data-focus="sample-rate" … />      spotlight('sample-rate')
export const SPOTLIGHT_CLASS = 'spotlight';
export const SPOTLIGHT_MS = 2500;

export interface SpotlightOptions {
	/** Where a data-focus id is looked up. Defaults to `document`. */
	root?: ParentNode;
	/** How long the ring stays, in ms. */
	durationMs?: number;
	/** Scroll the target into view (default true). */
	scroll?: boolean;
	/** Move keyboard focus to the target, or the first input inside it (default true). */
	focus?: boolean;
}

// One pending removal per element, so spotlighting the same control twice in a row restarts its
// full duration instead of the first timer cutting the second ring short.
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function escapeId(id: string): string {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

function reducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The element a target names, or null — a data-focus id is resolved against `root`. */
export function resolveSpotlightTarget(target: Element | string, root?: ParentNode): Element | null {
	if (typeof target !== 'string') return target;
	const scope = root ?? (typeof document !== 'undefined' ? document : null);
	return scope?.querySelector(`[data-focus="${escapeId(target)}"]`) ?? null;
}

/** Spotlight `target`. Returns false when there is nothing to spotlight (not rendered yet, or a
 *  data-focus id nothing on the page carries), so a caller can fall back to saying it in words. */
export function spotlight(target: Element | string, opts: SpotlightOptions = {}): boolean {
	const el = resolveSpotlightTarget(target, opts.root);
	if (!el) return false;
	if (opts.scroll !== false) {
		el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
	}
	// Remove + reflow + add restarts the CSS animation when the class is already on.
	el.classList.remove(SPOTLIGHT_CLASS);
	void (el as HTMLElement).offsetWidth;
	el.classList.add(SPOTLIGHT_CLASS);
	const prev = timers.get(el);
	if (prev) clearTimeout(prev);
	timers.set(el, setTimeout(() => {
		el.classList.remove(SPOTLIGHT_CLASS);
		timers.delete(el);
	}, opts.durationMs ?? SPOTLIGHT_MS));
	if (opts.focus !== false) {
		const field = el.matches?.('input, select, textarea, button')
			? el
			: el.querySelector?.('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
		(field as HTMLElement | null)?.focus?.({ preventScroll: true });
	}
	return true;
}
