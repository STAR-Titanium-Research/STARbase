// The scene's materials, coloured from the resolved theme palette (re-coloured on a theme change).
// State colours are the kit's: fresh --d1-ok, partly used --d1-warn, used --d1-dim, selection --d1-accent; the
// selected edge is its own saturated blue (the palette's `select`).

import {
	ACESFilmicToneMapping, Color, MeshBasicMaterial, MeshStandardMaterial, SRGBColorSpace, type Material,
} from 'three';
import type { InsertState } from '@d1/ui';
import { luminance, type Palette, type Rgba } from './themePalette';

export const GHOST_OPACITY = 0.35;

export function setColor(target: Color, c: Rgba): void {
	target.setRGB(c.r, c.g, c.b, SRGBColorSpace);
}

// Flat, tone-map-free colour so the 3D state colours match the pills and the rest of the page.
function flat(opacity = 1, extra: { depthWrite?: boolean } = {}): MeshBasicMaterial {
	return new MeshBasicMaterial({
		toneMapped: false, transparent: opacity < 1, opacity, depthWrite: extra.depthWrite ?? opacity >= 1,
		polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
	});
}

export type RingTone = InsertState | 'selected' | 'hover';
export type EdgeTone = 'fresh' | 'used' | 'freshGhost' | 'usedGhost' | 'selected' | 'glow' | 'hover' | 'halo';

// The ink of the etched slot numbers: the page's ink, eased toward the tray so it reads as cut into it rather than
// printed on it. A dark tray gets a lighter-than-tray ink (the page's ink is light there), a light tray a darker one.
export function etchInk(ink: Rgba, tray: Rgba, dark: boolean): Rgba {
	const t = dark ? 0.3 : 0.15;
	const mix = (a: number, b: number) => a + (b - a) * t;
	return { r: mix(ink.r, tray.r), g: mix(ink.g, tray.g), b: mix(ink.b, tray.b), a: 1 };
}

export class SceneMaterials {
	readonly body = new MeshStandardMaterial({ metalness: 0.6, roughness: 0.35 });
	readonly bodyGhost = new MeshStandardMaterial({
		metalness: 0.6, roughness: 0.35, transparent: true, opacity: GHOST_OPACITY, depthWrite: false,
	});
	// The reference arrow is flat and un-tone-mapped: it stays the same bright mark whatever the light does.
	readonly mark = new MeshBasicMaterial({ toneMapped: false });
	// Brazed tips: lighter and shinier than the carbide body.
	readonly tipPcd = new MeshStandardMaterial({ metalness: 0.7, roughness: 0.26 });
	readonly tipCbn = new MeshStandardMaterial({ metalness: 0.65, roughness: 0.36 });
	readonly tray = new MeshStandardMaterial({ metalness: 0.02, roughness: 0.82 });
	// The etched slot numbers: white glyphs from the atlas (BoxView sets `map`), tinted by `color`; flat, over the tray top.
	readonly etch = new MeshBasicMaterial({
		toneMapped: false, transparent: true, depthWrite: false,
		polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
	});
	readonly shadow = new MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, toneMapped: false });
	readonly ring: Record<RingTone, MeshBasicMaterial> = {
		fresh: flat(), 'partly-used': flat(), used: flat(0.85), depleted: flat(GHOST_OPACITY),
		selected: flat(0.6), hover: flat(0.4),
	};
	readonly edge: Record<EdgeTone, MeshBasicMaterial> = {
		fresh: flat(), used: flat(), freshGhost: flat(GHOST_OPACITY), usedGhost: flat(GHOST_OPACITY),
		selected: flat(), glow: flat(0.4), hover: flat(0.85), halo: flat(0.6),
	};
	isDark = false;

	constructor(palette: Palette) {
		this.update(palette);
	}

	update(p: Palette): void {
		this.isDark = luminance(p.tile) < 0.35;
		setColor(this.body.color, p.body);
		setColor(this.bodyGhost.color, p.body);
		setColor(this.mark.color, p.mark);
		setColor(this.tipPcd.color, p.tipPcd);
		setColor(this.tipCbn.color, p.tipCbn);
		setColor(this.tray.color, p.tray);
		setColor(this.etch.color, etchInk(p.ink, p.tray, this.isDark));
		this.shadow.opacity = this.isDark ? 0.55 : 0.26;
		setColor(this.ring.fresh.color, p.ok);
		setColor(this.ring['partly-used'].color, p.warn);
		setColor(this.ring.used.color, p.dim);
		setColor(this.ring.depleted.color, p.dim);
		setColor(this.ring.selected.color, p.accent);
		setColor(this.ring.hover.color, p.accent);
		setColor(this.edge.fresh.color, p.ok);
		setColor(this.edge.freshGhost.color, p.ok);
		setColor(this.edge.used.color, p.dim);
		setColor(this.edge.usedGhost.color, p.dim);
		setColor(this.edge.selected.color, p.select);
		setColor(this.edge.glow.color, p.select);
		setColor(this.edge.hover.color, p.pick);
		setColor(this.edge.halo.color, p.ok);
	}

	// Exposure for the ACES curve: a touch lower on a dark stage so the carbide does not wash out.
	get exposure(): number { return this.isDark ? 0.95 : 1.05; }

	dispose(): void {
		const all: Material[] = [
			this.body, this.bodyGhost, this.mark, this.tipPcd, this.tipCbn, this.tray, this.etch, this.shadow,
			...Object.values(this.ring), ...Object.values(this.edge),
		];
		for (const m of all) m.dispose();
	}
}

export const TONE_MAPPING = ACESFilmicToneMapping;
