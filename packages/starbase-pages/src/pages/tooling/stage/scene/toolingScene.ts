// The 3D view of a tool box. Imperative and outside Vue reactivity; ToolingStage.vue loads this module with a
// dynamic import() so three.js stays out of the entry chunk. Render on demand: a frame is drawn when something
// changed (an input, an ease, a theme change, new data), and nothing runs at rest. The one exception is the
// gentle pulse on the next fresh edge: about 30 fps for three cycles after a focus, model or next-fresh change
// while the stage is on screen, then one static frame at full strength (pulse.ts).

import {
	DirectionalLight, Mesh, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Raycaster, Scene,
	SRGBColorSpace, Vector2, WebGLRenderer, type WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ToolingFocus, ToolingModel } from '@d1/ui';
import { BoxView } from './boxView';
import { shadowTexture, SHADOW_FILL } from './groundShadow';
import { liftTargets, LIFT_MM, stepLifts } from './lifts';
import {
	frameBox, frameEdge, frameInsert, FOV_DEG, framingFromCamera, FramingTween, moveDuration, orbitLimits,
	prefersReducedMotion, POLAR_MAX, POLAR_MIN, type Framing, type Vec3,
} from './cameraRig';
import { LabelLayer } from './labels';
import { SceneMaterials, TONE_MAPPING } from './materials';
import { sameTarget, type PickTarget } from './pick';
import { wireCanvasInput } from './canvasInput';
import { RenderLoop, type LoopHost } from './renderLoop';
import { ThemeProbe } from './themePalette';

type NextFresh = { insertId: string; edgeId: string } | null;

export class ToolingScene {
	private readonly renderer: WebGLRenderer;
	private readonly scene = new Scene();
	private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 1, 3000);
	private readonly controls: OrbitControls;
	private readonly raycaster = new Raycaster();
	private readonly probe: ThemeProbe;
	private readonly mats: SceneMaterials;
	private readonly labels: LabelLayer;
	private readonly envTarget: WebGLRenderTarget;
	private readonly shadowTex = shadowTexture();
	private readonly shadow: Mesh;
	private readonly tween = new FramingTween();
	private readonly io: IntersectionObserver | null;
	private readonly loop: RenderLoop;

	private view: BoxView | null = null;
	private model: ToolingModel | null = null;
	private focus: ToolingFocus = { kind: 'box' };
	private nextFresh: NextFresh = null;
	private hover: PickTarget | null = null;

	private lifts = new Map<string, number>();
	private liftFrom = new Map<string, number>();
	private liftTo = new Map<string, number>();
	private finalFraming: Framing | null = null;
	private userMoved = false;
	private width = 0;
	private height = 0;

	private visible = true;
	private disposed = false;
	private hoverQueued: { x: number; y: number } | null = null;

	private pickCb: ((t: PickTarget) => void) | null = null;
	private hoverCb: ((t: PickTarget | null, x: number, y: number) => void) | null = null;
	private lostCb: (() => void) | null = null;
	private readonly cleanups: Array<() => void> = [];

	constructor(private readonly canvas: HTMLCanvasElement, private readonly overlay: HTMLElement) {
		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.toneMapping = TONE_MAPPING;
		this.renderer.outputColorSpace = SRGBColorSpace;

		const host: LoopHost = {
			ready: () => !this.disposed && this.view !== null,
			pulseAllowed: () => this.pulseAllowed(),
			advance: (now) => this.advance(now),
			draw: (pulse) => this.draw(pulse),
		};
		this.loop = new RenderLoop(host);

		this.probe = new ThemeProbe(overlay);
		this.mats = new SceneMaterials(this.probe.resolve());
		this.renderer.toneMappingExposure = this.mats.exposure;

		// A soft studio environment for the carbide's reflections, and one key light for definition.
		const pmrem = new PMREMGenerator(this.renderer);
		const room = new RoomEnvironment();
		this.envTarget = pmrem.fromScene(room, 0.04);
		this.scene.environment = this.envTarget.texture;
		this.scene.environmentIntensity = 0.9;
		room.dispose();
		pmrem.dispose();
		const key = new DirectionalLight(0xffffff, 0.8);
		key.position.set(35, 80, 45);
		this.scene.add(key);

		// A soft ground shadow under the tray.
		this.mats.shadow.map = this.shadowTex;
		this.shadow = new Mesh(new PlaneGeometry(1, 1), this.mats.shadow);
		this.shadow.rotation.x = -Math.PI / 2;
		this.shadow.position.y = -0.6;
		this.shadow.renderOrder = -1;
		this.scene.add(this.shadow);

		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;
		this.controls.enablePan = false;
		this.controls.rotateSpeed = 0.7;
		this.controls.zoomSpeed = 0.8;
		this.controls.minPolarAngle = POLAR_MIN;
		this.controls.maxPolarAngle = POLAR_MAX;

		this.labels = new LabelLayer(overlay, (t) => this.pickCb?.(t));
		this.io = typeof IntersectionObserver === 'function'
			? new IntersectionObserver((entries) => {
				this.visible = entries.some((e) => e.isIntersecting);
				if (this.visible) this.requestRender();
			})
			: null;
		this.io?.observe(canvas);
		this.listen();
		this.resize();
	}

	// --- wiring ----------------------------------------------------------------------------------------

	private listen(): void {
		this.cleanups.push(wireCanvasInput(this.canvas, {
			click: (x, y) => {
				const t = this.pickAt(x, y);
				if (t) this.pickCb?.(t);
			},
			hover: (x, y) => {
				this.hoverQueued = { x, y };
				this.loop.schedule();
			},
			leave: () => { this.hoverQueued = null; this.setHover(null, 0, 0); },
			contextLost: () => this.lostCb?.(),
		}));

		const onChange = () => this.requestRender();
		const onStart = () => {
			this.userMoved = true;
			this.settle();
		};
		this.controls.addEventListener('change', onChange);
		this.controls.addEventListener('start', onStart);
		this.cleanups.push(() => { this.controls.removeEventListener('change', onChange); this.controls.removeEventListener('start', onStart); });
		const onVis = () => { if (document.visibilityState === 'visible') this.requestRender(); };
		document.addEventListener('visibilitychange', onVis);
		this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
		this.probe.watch(() => this.refreshTheme());
	}

	onPick(cb: (t: PickTarget) => void): void { this.pickCb = cb; }
	onHover(cb: (t: PickTarget | null, x: number, y: number) => void): void { this.hoverCb = cb; }
	onContextLost(cb: () => void): void { this.lostCb = cb; }

	// --- inputs from the stage ---------------------------------------------------------------------------

	setModel(model: ToolingModel): void {
		const sameBox = this.model?.boxId === model.boxId;
		this.model = model;
		this.view?.dispose();
		this.view = new BoxView(model, this.mats);
		this.scene.add(this.view.root);
		const l = this.view.layout;
		this.shadow.scale.set(l.width / SHADOW_FILL, l.depth / SHADOW_FILL, 1);
		if (!this.focusValid(this.focus)) this.focus = { kind: 'box' };
		this.liftFrom = new Map();
		this.liftTo = liftTargets(this.focus);
		this.lifts = new Map(this.liftTo);
		this.hover = null;
		this.labels.set(this.view.labels(this.focus));
		this.loop.restartPulse();
		if (!sameBox || this.finalFraming === null) this.goTo(this.focus, true);
		else this.requestRender();
	}

	setFocus(focus: ToolingFocus): void {
		if (!this.model || !this.view) { this.focus = focus; return; }
		const next = this.focusValid(focus) ? focus : { kind: 'box' as const };
		this.focus = next;
		this.userMoved = false;
		this.labels.set(this.view.labels(next));
		this.loop.restartPulse();
		this.goTo(next, false);
	}

	setNextFresh(next: NextFresh): void {
		if (next?.edgeId !== this.nextFresh?.edgeId) this.loop.restartPulse();
		this.nextFresh = next;
		this.requestRender();
	}

	resetView(): void {
		this.userMoved = false;
		this.goTo(this.focus, false);
	}

	resize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w <= 0 || h <= 0 || this.disposed) return;
		const changed = w !== this.width || h !== this.height;
		this.width = w;
		this.height = h;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		// Until the user has moved the camera, keep the framing fitted to the new shape of the stage.
		if (changed && this.model && !this.userMoved) this.goTo(this.focus, true);
		else this.requestRender();
	}

	refreshTheme(): void {
		if (this.disposed) return;
		this.mats.update(this.probe.resolve());
		this.renderer.toneMappingExposure = this.mats.exposure;
		this.requestRender();
	}

	// --- camera and lifts ----------------------------------------------------------------------------------

	private focusValid(f: ToolingFocus): boolean {
		if (!this.model || f.kind === 'box') return true;
		const insert = this.model.inserts.find((i) => i.id === f.insertId);
		if (!insert) return false;
		return f.kind === 'insert' || insert.edges.some((e) => e.id === f.edgeId);
	}

	private framingFor(f: ToolingFocus): Framing {
		const view = this.view!;
		const aspect = this.camera.aspect || 1.6;
		if (f.kind === 'box') return frameBox(view.layout, aspect);
		const centre: Vec3 = view.insertCentre(f.insertId, LIFT_MM);
		const { geometry, outline } = view.model;
		if (f.kind === 'insert') return frameInsert(centre, geometry, outline, aspect);
		const placement = view.placementOf(f.edgeId);
		return placement ? frameEdge(centre, geometry, outline, placement, aspect) : frameInsert(centre, geometry, outline, aspect);
	}

	private applyFraming(f: Framing): void {
		this.camera.position.set(...f.position);
		this.controls.target.set(...f.target);
		this.camera.lookAt(this.controls.target);
	}

	private applyLimits(f: Framing): void {
		const l = orbitLimits(f);
		this.controls.minDistance = l.minDistance;
		this.controls.maxDistance = l.maxDistance;
		this.controls.minPolarAngle = l.minPolar;
		this.controls.maxPolarAngle = l.maxPolar;
	}

	// Ease the camera (and the lifted insert) to a focus; instantly when asked or under reduced motion.
	private goTo(f: ToolingFocus, instant: boolean): void {
		if (!this.view) return;
		const to = this.framingFor(f);
		this.finalFraming = to;
		this.liftFrom = new Map(this.lifts);
		this.liftTo = liftTargets(f);
		const duration = instant ? 0 : moveDuration();
		if (duration === 0) {
			this.tween.cancel();
			this.lifts = new Map(this.liftTo);
			this.applyFraming(to);
			this.applyLimits(to);
			this.controls.update();
		} else {
			// Wide limits while moving: the in-between framings may lie outside the destination's limits.
			this.controls.minDistance = 0;
			this.controls.maxDistance = Infinity;
			this.controls.minPolarAngle = 0;
			this.controls.maxPolarAngle = Math.PI;
			this.tween.start(framingFromCamera(this.camera.position.toArray() as Vec3, this.controls.target.toArray() as Vec3), to, performance.now(), duration);
		}
		this.requestRender();
	}

	// The user grabbed the camera mid-move: stop where it is, with the insert already at its destination.
	private settle(): void {
		if (!this.tween.active) return;
		this.tween.cancel();
		this.lifts = new Map(this.liftTo);
		if (this.finalFraming) this.applyLimits(this.finalFraming);
		this.requestRender();
	}

	// --- picking and hover ------------------------------------------------------------------------------------

	private pickAt(clientX: number, clientY: number): PickTarget | null {
		if (!this.view) return null;
		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this.raycaster.layers.enableAll();
		this.raycaster.setFromCamera(ndc, this.camera);
		const hits = this.raycaster.intersectObjects(this.view.pickables(this.focus), false);
		for (const h of hits) {
			const t = this.view.resolve(h, this.focus);
			if (t) return t;
		}
		return null;
	}

	private setHover(t: PickTarget | null, x: number, y: number): void {
		const changed = !sameTarget(t, this.hover);
		this.hover = t;
		if (changed) this.canvas.style.cursor = t ? 'pointer' : '';
		this.hoverCb?.(t, x, y);
		if (changed) this.requestRender();
	}

	// --- the render loop (on demand; timing lives in renderLoop.ts) -----------------------------------------------

	requestRender(): void {
		this.loop.request();
	}

	// Pulsing only while the stage is on screen, motion is allowed, and the next fresh edge is not the focused one.
	private pulseAllowed(): boolean {
		return this.nextFresh !== null && this.visible && document.visibilityState !== 'hidden' && !prefersReducedMotion()
			&& !(this.focus.kind === 'edge' && this.focus.edgeId === this.nextFresh.edgeId);
	}

	// Everything that moves on its own: the queued hover pick, the camera ease and lifts, orbit damping.
	private advance(now: number): boolean {
		if (this.hoverQueued) {
			const q = this.hoverQueued;
			this.hoverQueued = null;
			const rect = this.canvas.getBoundingClientRect();
			this.setHover(this.pickAt(q.x, q.y), q.x - rect.left, q.y - rect.top);
		}

		let busy = false;
		if (this.tween.active) {
			this.lifts = stepLifts(this.liftFrom, this.liftTo, this.tween.eased(now));
			const s = this.tween.sample(now);
			if (s) {
				this.applyFraming(s.framing);
				if (s.done) {
					this.lifts = new Map(this.liftTo);
					if (this.finalFraming) this.applyLimits(this.finalFraming);
				} else busy = true;
			}
			this.loop.request();
		}
		if (this.controls.update()) busy = true; // damping keeps going after the pointer is released
		return busy;
	}

	private draw(pulse: number): void {
		const view = this.view;
		if (!view) return;
		view.sync({ focus: this.focus, lifts: this.lifts, hover: this.hover, nextFresh: this.nextFresh, pulse });
		this.renderer.render(this.scene, this.camera);
		this.labels.update(this.camera, this.width, this.height, (id) => this.lifts.get(id) ?? 0);
	}

	// --- teardown -------------------------------------------------------------------------------------------------

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.loop.dispose();
		for (const c of this.cleanups) c();
		this.cleanups.length = 0;
		this.io?.disconnect();
		this.controls.dispose();
		this.view?.dispose();
		this.view = null;
		this.labels.dispose();
		this.probe.dispose();
		this.shadow.geometry.dispose();
		this.shadowTex.dispose();
		this.mats.dispose();
		this.envTarget.dispose();
		this.scene.environment = null;
		this.scene.clear();
		this.canvas.style.cursor = '';
		try { this.renderer.forceContextLoss(); } catch { /* already gone */ }
		this.renderer.dispose();
	}
}
