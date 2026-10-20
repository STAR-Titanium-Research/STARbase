// A colour given as `var(--d1-series-1, #2a78d6)` works in SVG and CSS but not on a <canvas> or in
// an exported SVG/PNG file, which have no page styles to look the variable up in. This returns the
// colour the page currently shows for it; a plain colour comes back unchanged. Resolved values are
// cached per colour and theme, so a redraw does not touch the DOM.
const cache = new Map<string, string>();

export function resolveColor(c: string | undefined, fallback = ''): string {
	if (!c || !c.startsWith('var(') || typeof document === 'undefined') return c ?? fallback;
	const key = `${document.documentElement.getAttribute('data-theme') ?? ''}|${c}`;
	let out = cache.get(key);
	if (out === undefined) {
		const el = document.createElement('span');
		el.style.color = c;
		document.body.appendChild(el);
		out = getComputedStyle(el).color;
		el.remove();
		cache.set(key, out);
	}
	return out || fallback;
}
