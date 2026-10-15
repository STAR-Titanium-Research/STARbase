// Theme colours for the scene. The page's colours are CSS custom properties, and a raw property value can
// be an unresolved light-dark() or color-mix(), so each colour is resolved by applying the expression to a
// hidden probe element's `color` and reading the computed value back.

export interface Rgba { r: number; g: number; b: number; a: number } // sRGB, 0 to 1

export const PALETTE_EXPRESSIONS = {
	tile: 'var(--d1-tile, var(--theme--background-subdued))',
	tray: 'light-dark(color-mix(in srgb, var(--theme--foreground) 12%, var(--d1-tile, var(--theme--background-subdued))), color-mix(in srgb, var(--theme--foreground) 5%, var(--d1-tile, var(--theme--background-subdued))))',
	ink: 'var(--theme--foreground)',
	body: 'light-dark(color-mix(in srgb, var(--theme--foreground) 88%, var(--theme--background)), color-mix(in srgb, var(--theme--foreground) 42%, var(--theme--background)))', // dark theme: a mid grey, well clear of the near-black tray
	// The reference arrow: near-white in both themes, so it is the brightest thing on the graphite top face.
	mark: 'light-dark(color-mix(in srgb, var(--theme--foreground) 5%, var(--theme--background)), color-mix(in srgb, var(--theme--foreground) 96%, var(--theme--background)))',
	// Brazed tips, lighter than the carbide body in both themes. PCD is near-silver; CBN is a warm, dark gold-grey
	// (the warning amber stirred into a grey from the same foreground).
	tipPcd: 'light-dark(color-mix(in srgb, var(--theme--foreground) 14%, var(--theme--background)), color-mix(in srgb, var(--theme--foreground) 86%, var(--theme--background)))',
	tipCbn: 'color-mix(in srgb, var(--d1-warn, var(--theme--warning)) 42%, light-dark(color-mix(in srgb, var(--theme--foreground) 52%, var(--theme--background)), color-mix(in srgb, var(--theme--foreground) 50%, var(--theme--background))))',
	ok: 'var(--d1-ok, var(--theme--success))',
	warn: 'var(--d1-warn, var(--theme--warning))',
	dim: 'var(--d1-dim, var(--theme--foreground-subdued))',
	accent: 'var(--d1-accent, var(--theme--primary))',
	// The accent, lifted toward white: the selected and hovered edge sit on a dark graphite body, where the
	// light theme's near-black accent would vanish.
	pick: 'color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 50%, var(--theme--foreground-inverted))',
	// The selected edge: a saturated blue that no state colour (ok, warn, dim) and no insert body is close to. A page
	// can retheme it with --d1-select; the stage's selected pill reads the same variable.
	select: 'var(--d1-select, royalblue)',
} as const;

export type PaletteKey = keyof typeof PALETTE_EXPRESSIONS;
export type Palette = Record<PaletteKey, Rgba>;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const FALLBACK: Rgba = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

function channel(token: string, scale: number): number | null {
	if (token === 'none') return 0;
	const pct = token.endsWith('%');
	const n = Number(pct ? token.slice(0, -1) : token);
	if (!Number.isFinite(n)) return null;
	return clamp01(pct ? n / 100 : n / scale);
}

// rgb(), rgba(), color(srgb ...) and #hex: the forms getComputedStyle gives for the colours above. Anything
// else (oklab, display-p3 ...) is null; the probe then asks a canvas to convert it.
export function parseCssColor(text: string): Rgba | null {
	const s = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(s);
	if (hex) {
		const h = hex[1];
		const full = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h;
		if (full.length !== 6 && full.length !== 8) return null;
		const v = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
		return { r: v(0), g: v(2), b: v(4), a: full.length === 8 ? v(6) : 1 };
	}
	const fn = /^(rgba?|color)\(\s*(.+)\)$/.exec(s);
	if (!fn) return null;
	let body = fn[2];
	if (fn[1] === 'color') {
		if (!body.startsWith('srgb ')) return null;
		body = body.slice(5);
	}
	const [main, slashAlpha] = body.split('/').map((p) => p.trim());
	const parts = main.split(/[\s,]+/).filter(Boolean);
	let alphaToken: string | undefined = slashAlpha;
	if (alphaToken === undefined && parts.length === 4) alphaToken = parts.pop();
	if (parts.length !== 3) return null;
	const scale = fn[1] === 'color' ? 1 : 255;
	const rgb = parts.map((p) => channel(p, scale));
	const a = alphaToken === undefined ? 1 : channel(alphaToken, 1);
	if (rgb.some((v) => v === null) || a === null) return null;
	return { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a };
}

// Relative luminance, to tell a dark tile from a light one.
export function luminance(c: Rgba): number {
	const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
	return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

// Whatever the parser could not read, the browser can: paint it on a 1x1 canvas and read the pixel.
function viaCanvas(css: string): Rgba | null {
	if (typeof document === 'undefined') return null;
	try {
		const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		ctx.canvas.width = ctx.canvas.height = 1;
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
		return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
	} catch {
		return null;
	}
}

export class ThemeProbe {
	private readonly probe: HTMLElement;
	private cleanup: Array<() => void> = [];

	constructor(host: HTMLElement) {
		this.probe = document.createElement('span');
		this.probe.setAttribute('aria-hidden', 'true');
		this.probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
		host.appendChild(this.probe);
	}

	private one(expression: string): Rgba {
		this.probe.style.color = '';
		this.probe.style.color = expression;
		const computed = getComputedStyle(this.probe).color;
		return parseCssColor(computed) ?? viaCanvas(computed) ?? FALLBACK;
	}

	resolve(): Palette {
		const out = {} as Palette;
		for (const key of Object.keys(PALETTE_EXPRESSIONS) as PaletteKey[]) out[key] = this.one(PALETTE_EXPRESSIONS[key]);
		return out;
	}

	// Calls back (once per frame at most) when the colour scheme or a theme attribute changes.
	watch(onChange: () => void): void {
		let queued = false;
		const fire = () => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => { queued = false; onChange(); });
		};
		const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
		mq?.addEventListener('change', fire);
		const mo = new MutationObserver(fire);
		const opts = { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] };
		mo.observe(document.documentElement, opts);
		if (document.body) mo.observe(document.body, opts);
		this.cleanup.push(() => mq?.removeEventListener('change', fire), () => mo.disconnect());
	}

	dispose(): void {
		for (const c of this.cleanup) c();
		this.cleanup = [];
		this.probe.remove();
	}
}
