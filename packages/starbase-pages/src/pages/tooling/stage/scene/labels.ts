// Crisp HTML labels over the canvas: small rounded pills, positioned by projecting 3D anchors each rendered
// frame. They are styled by the stage (classes d1-tstage-pill*), so they use the page's theme variables.

import { Vector3, type Camera } from 'three';
import type { PickTarget } from './pick';

export type LabelTone = 'ok' | 'warn' | 'dim' | 'accent' | 'none';

export interface LabelSpec {
	key: string;
	text: string;
	anchor: [number, number, number]; // world, before the insert's lift
	insertId?: string; // the anchor rides up with this insert's lift
	// An edge's face (+1 top, -1 underside) and its corner's outward direction in the ground plane: the pill fades
	// while both face away from the camera, i.e. the edge is behind the insert body (an underside letter seen from above).
	faceY?: 1 | -1;
	outward?: [number, number];
	tone: LabelTone;
	selected?: boolean;
	target: PickTarget | null; // what a click on the pill selects
	title: string; // accessible name
}

interface Entry { spec: LabelSpec; el: HTMLElement; x: number; y: number; z: number; hidden: boolean; occluded: boolean }

// Is an edge anchor behind the insert body, seen from `toCamera` (anchor → camera)?
export function edgeOccluded(spec: Pick<LabelSpec, 'faceY' | 'outward'>, toCamera: [number, number, number]): boolean {
	if (!spec.faceY || !spec.outward) return false;
	const facing = spec.faceY * toCamera[1] > 0;
	const side = spec.outward[0] * toCamera[0] + spec.outward[1] * toCamera[2] > 0;
	return !facing && !side;
}

export class LabelLayer {
	private entries = new Map<string, Entry>();
	private readonly v = new Vector3();

	constructor(private readonly root: HTMLElement, private readonly onClick: (target: PickTarget) => void) {}

	get size(): number { return this.entries.size; }

	private build(spec: LabelSpec): HTMLElement {
		const clickable = spec.target !== null;
		const el = document.createElement(clickable ? 'button' : 'span');
		el.className = 'd1-tstage-pill';
		if (el instanceof HTMLButtonElement) {
			el.type = 'button';
			el.tabIndex = -1;
		}
		el.setAttribute('aria-label', spec.title);
		const dot = document.createElement('span');
		dot.className = 'd1-tstage-pill__dot';
		const text = document.createElement('span');
		text.className = 'd1-tstage-pill__text';
		el.append(dot, text);
		const target = spec.target;
		if (target) {
			// A pill must not take keyboard focus from the stage, or Esc and the arrow keys would stop working.
			el.addEventListener('mousedown', (ev) => ev.preventDefault());
			el.addEventListener('click', (ev) => { ev.stopPropagation(); this.onClick(target); });
		}
		this.root.appendChild(el);
		return el;
	}

	private paint(e: Entry, spec: LabelSpec): void {
		e.spec = spec;
		e.el.dataset.tone = spec.tone;
		e.el.classList.toggle('is-selected', spec.selected === true);
		const text = e.el.lastElementChild as HTMLElement;
		if (text.textContent !== spec.text) text.textContent = spec.text;
		e.el.setAttribute('aria-label', spec.title);
	}

	// Diffs by key: pills that stay are updated in place, new ones are created, the rest removed.
	set(specs: LabelSpec[]): void {
		const next = new Map<string, Entry>();
		for (const spec of specs) {
			let e = this.entries.get(spec.key);
			if (e) this.entries.delete(spec.key);
			else e = { spec, el: this.build(spec), x: NaN, y: NaN, z: 0, hidden: true, occluded: false };
			this.paint(e, spec);
			next.set(spec.key, e);
		}
		for (const e of this.entries.values()) e.el.remove();
		this.entries = next;
	}

	update(camera: Camera, width: number, height: number, liftOf: (insertId: string) => number): void {
		for (const e of this.entries.values()) {
			const a = e.spec.anchor;
			const ay = a[1] + (e.spec.insertId ? liftOf(e.spec.insertId) : 0);
			const cam = camera.position;
			const occluded = edgeOccluded(e.spec, [cam.x - a[0], cam.y - ay, cam.z - a[2]]);
			if (occluded !== e.occluded) {
				e.occluded = occluded;
				e.el.classList.toggle('is-occluded', occluded);
			}
			this.v.set(a[0], ay, a[2]).project(camera);
			const x = (this.v.x * 0.5 + 0.5) * width;
			const y = (-this.v.y * 0.5 + 0.5) * height;
			const hidden = this.v.z > 1 || this.v.z < -1 || x < -40 || y < -40 || x > width + 40 || y > height + 40;
			if (hidden !== e.hidden) {
				e.hidden = hidden;
				e.el.style.visibility = hidden ? 'hidden' : 'visible';
			}
			if (hidden) continue;
			if (!(Math.abs(x - e.x) <= 0.1 && Math.abs(y - e.y) <= 0.1)) {
				e.x = x;
				e.y = y;
				e.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
			}
			const z = Math.round((1 - this.v.z) * 5000);
			if (z !== e.z) { e.z = z; e.el.style.zIndex = String(z); }
		}
	}

	dispose(): void {
		for (const e of this.entries.values()) e.el.remove();
		this.entries.clear();
	}
}
