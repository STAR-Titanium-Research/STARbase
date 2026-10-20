// A colour given as `var(--d1-series-1, #2a78d6)` works in SVG and CSS but not on a <canvas> or in
// an exported SVG/PNG file, which have no page styles to look the variable up in. This returns the
// colour the page currently shows for it; a plain colour comes back unchanged.
export function resolveColor(c: string | undefined, fallback = ''): string {
	if (!c || !c.startsWith('var(') || typeof document === 'undefined') return c ?? fallback;
	const el = document.createElement('span');
	el.style.color = c;
	document.body.appendChild(el);
	const out = getComputedStyle(el).color;
	el.remove();
	return out || fallback;
}
