// The 3D view of a tool box. Imperative and outside Vue reactivity; ToolingStage.vue loads this module with a
// dynamic import() so three.js stays out of the entry chunk. Render on demand: a frame is drawn when something
// changed (an input, an ease, a theme change, new data), and nothing runs at rest. The one exception is the
// gentle pulse on the next fresh edge and on the glow around a selected edge: about 30 fps for three cycles after
// a focus, model or next-fresh change while the stage is on screen, then one static frame at full strength (pulse.ts).

import {
	DirectionalLight, Mesh, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Raycaster, Scene,
	SRGBColorSpace, Vector2, WebGLRenderer, type WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ToolingFocus, ToolingModel } from '@d1/ui';
import { BoxView } from './boxView';
import { shadowTexture, SHADOW_FILL } from './groundShadow';
import { liftTargets, LIFT_MM, LiftMotion } from './lifts';
import { easeInOutCubic, easeOutCubic, motionMs, RECENTRE_MS } from './motion';
import {
	frameBox, frameEdge, frameInsert, FOV_DEG, framingFromCamera, framingsClose, FramingTween, moveDuration,
	orbitLimitsAround, prefersReducedMotion, RECENTRE_DELAY_MS, recentreFraming, rotationBounds, rubberView, springToBounds,
	withinBounds, type Framing, type SpringVelocity, type Vec3,
} from './cameraRig';
import { LabelLayer } from './labels';
import { SceneMaterials, TONE_MAPPING } from './materials';
import { sameTarget, type PickTarget } from './pick';
import { trackPointers, wireCanvasInput } from './canvasInput';
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
	private readonly liftMotion = new LiftMotion(); // each insert's lift eases on its own (lifts.ts)
	private finalFraming: Framing | null = null;
	private userMoved = false;
	private dragging = false; // a pointer is down on the orbit: no springing back to the bounds yet
	private lastAdvance = 0;
	private prevView: Framing | null = null; // the camera as the last frame left it, to damp this frame's drag step by
	private spring: SpringVelocity = { azimuth: 0, polar: 0 }; // how fast the view is springing back to a bound
	private recentreTimer: ReturnType<typeof setTimeout> | null = null;
	private limitsWidened = false; // the orbit limits were widened to hold a view grabbed mid-move, outside them
	private recentring = false; // the camera tween under way is a recentre, not a flight to a focus
	private readonly pointers: { count(): number; dispose(): void }; // pointers down on the canvas: an orbit (a wheel zoom has none)
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

		this.pointers = trackPointers(canvas); // before the orbit controls listen, so its count is up when they start
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;
		this.controls.enablePan = false;
		this.controls.rotateSpeed = 0.7;
		this.controls.zoomSpeed = 0.8;

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
			this.dragging = true;
			if (this.pointers.count() > 0) this.cancelRecentre(); // an orbit: no recentre pending, and one under way stops where it is
			const recentring = this.tween.active && this.recentring;
			this.settle();
			if (recentring && this.pointers.count() === 0) this.scheduleRecentre(); // a wheel zoom stopped it: it picks up again
		};
		const onEnd = () => {
			this.dragging = false;
			this.lastAdvance = performance.now(); // the loop slept while the pointer was held still: no long first step
			if (this.pointers.count() > 0) this.scheduleRecentre(); // after an orbit; a wheel zoom alone does not recentre
			this.requestRender(); // released: the view may spring back inside the bounds
		};
		this.cleanups.push(this.pointers.dispose);
		this.controls.addEventListener('change', onChange);
		this.controls.addEventListener('start', onStart);
		this.controls.addEventListener('end', onEnd);
		this.cleanups.push(() => {
			this.controls.removeEventListener('change', onChange);
			this.controls.removeEventListener('start', onStart);
			this.controls.removeEventListener('end', onEnd);
		});
		const onVis = () => {
			if (document.visibilityState !== 'visible') return;
			this.lastAdvance = performance.now(); // no long first step after the tab was hidden
			this.requestRender();
		};
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
		this.view = new BoxView(model, this.mats, () => this.requestRender());
		this.scene.add(this.view.root);
		const l = this.view.layout;
		this.shadow.scale.set(l.width / SHADOW_FILL, l.depth / SHADOW_FILL, 1);
		if (!this.focusValid(this.focus)) this.focus = { kind: 'box' };
		this.hover = null;
		this.liftMotion.retarget(liftTargets(this.focus), performance.now(), { instant: true });
		this.lifts = this.liftMotion.sample(performance.now());
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
		if (changed && this.model && !this.userMoved) {
			if (this.tween.active) {
				// Selecting re-lays-out the page, so the stage often resizes mid-flight: refit the destination and keep flying
				// (snapping to it would cancel the animation every time).
				this.finalFraming = this.framingFor(this.focus);
				this.tween.retarget(this.finalFraming, performance.now());
				this.requestRender();
			} else this.goTo(this.focus, true);
		} else this.requestRender();
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
		this.prevView = null;
	}

	// The orbit limits of a framing. With `around` (the camera was grabbed mid-move), they are widened, only where that view
	// lies outside them, to hold it, so nothing jumps; `easeBack` restores the plain limits once the view is back inside.
	private applyLimits(f: Framing, around: Framing | null = null): void {
		const { limits: l, widened } = orbitLimitsAround(f, around);
		this.controls.minDistance = l.minDistance;
		this.controls.maxDistance = l.maxDistance;
		this.controls.minPolarAngle = l.minPolar;
		this.controls.maxPolarAngle = l.maxPolar;
		this.controls.minAzimuthAngle = l.minAzimuth;
		this.controls.maxAzimuthAngle = l.maxAzimuth;
		this.limitsWidened = widened;
	}

	// Wide limits while moving (the in-between framings may lie outside the destination's), and the camera eased to `to`.
	private startTween(to: Framing, ms: number, ease: (t: number) => number, t0: number): void {
		this.controls.minDistance = 0;
		this.controls.maxDistance = Infinity;
		this.controls.minPolarAngle = 0;
		this.controls.maxPolarAngle = Math.PI;
		this.controls.minAzimuthAngle = -Infinity;
		this.controls.maxAzimuthAngle = Infinity;
		this.tween.start(framingFromCamera(this.camera.position.toArray() as Vec3, this.controls.target.toArray() as Vec3), to, t0, ms, ease);
	}

	// Ease the camera to a focus, and lift the selected insert in step with it (the previous one drops in parallel); about
	// 400 ms, a little shorter under reduced motion, never instant (unless `instant`: a new model, a resize). A move made
	// while another is under way starts from where the camera is, with an ease-out, so it carries on without a jump.
	private goTo(f: ToolingFocus, instant: boolean): void {
		if (!this.view) return;
		this.cancelRecentre();
		const to = this.framingFor(f);
		this.finalFraming = to;
		const t0 = performance.now();
		this.liftMotion.retarget(liftTargets(f, this.hover), t0, { instant, reduced: prefersReducedMotion() });
		this.recentring = false;
		if (instant) {
			this.tween.cancel();
			this.applyFraming(to);
			this.applyLimits(to);
			this.controls.update();
			this.lifts = this.liftMotion.sample(t0);
		} else {
			this.startTween(to, moveDuration(), this.tween.active ? easeOutCubic : easeInOutCubic, t0);
		}
		this.requestRender();
	}

	// --- recentring -----------------------------------------------------------------------------------------------

	// Once the user lets go of an orbit and stays still, the camera eases back (rotation and target) to the focus's own
	// framing, about 380 ms with an ease-out, a little shorter under reduced motion. A zoom the user made is kept (within the
	// framing's zoom limits): zooming in to look at something is not undone. New input cancels it (see onStart).
	private scheduleRecentre(): void {
		this.cancelRecentre();
		this.recentreTimer = setTimeout(() => this.recentre(), RECENTRE_DELAY_MS);
	}

	private cancelRecentre(): void {
		if (this.recentreTimer !== null) clearTimeout(this.recentreTimer);
		this.recentreTimer = null;
	}

	private recentre(): void {
		this.recentreTimer = null;
		if (this.disposed || !this.view || this.dragging || this.tween.active || !this.finalFraming) return;
		const base = this.finalFraming;
		const now = framingFromCamera(this.camera.position.toArray() as Vec3, this.controls.target.toArray() as Vec3);
		const to = recentreFraming(base, now);
		if (framingsClose(now, to)) return; // already there
		this.recentring = true;
		this.startTween(to, motionMs(RECENTRE_MS), easeOutCubic, performance.now());
		this.requestRender();
	}

	// The user grabbed the camera mid-move: stop where it is. The lifts carry on on their own.
	private settle(): void {
		if (!this.tween.active) return;
		const view = framingFromCamera(this.camera.position.toArray() as Vec3, this.controls.target.toArray() as Vec3);
		this.tween.cancel();
		this.recentring = false;
		if (this.finalFraming) this.applyLimits(this.finalFraming, view);
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
		if (!changed) return;
		// The hovered insert rises a little, and the one the pointer left settles back (lifts.ts).
		this.liftMotion.retarget(liftTargets(this.focus, t), performance.now(), { reduced: prefersReducedMotion() });
		this.requestRender();
	}

	// --- the render loop (on demand; timing lives in renderLoop.ts) -----------------------------------------------

	requestRender(): void {
		this.loop.request();
	}

	// Pulsing only while the stage is on screen and motion is allowed: the glow of a selected edge, and the halo of the
	// next fresh edge when that is not the focused one.
	private pulseAllowed(): boolean {
		if (!this.visible || document.visibilityState === 'hidden' || prefersReducedMotion()) return false;
		if (this.focus.kind === 'edge') return true;
		return this.nextFresh !== null;
	}

	// Everything that moves on its own: the queued hover pick, the camera ease and lifts, orbit damping.
	private advance(now: number): boolean {
		if (this.hoverQueued) {
			const q = this.hoverQueued;
			this.hoverQueued = null;
			const rect = this.canvas.getBoundingClientRect();
			this.setHover(this.pickAt(q.x, q.y), q.x - rect.left, q.y - rect.top);
		}

		this.lifts = this.liftMotion.sample(now);
		let busy = this.liftMotion.moving; // inserts still rising or settling keep the loop going
		if (this.tween.active) {
			const s = this.tween.sample(now);
			if (s) {
				this.applyFraming(s.framing);
				if (s.done) {
					this.recentring = false;
					if (this.finalFraming) this.applyLimits(this.finalFraming);
				} else busy = true;
			}
			this.loop.request();
		}
		if (this.controls.update()) busy = true; // damping keeps going after the pointer is released
		if (this.easeBack(now)) busy = true;
		return busy;
	}

	// The soft rotation bounds. Dragging past one meets rising resistance (each frame's step is damped by how far past the
	// bound the view already is), and once let go the view springs back to it. Applied after the orbit controls have
	// moved the camera, which they re-read every frame.
	private easeBack(now: number): boolean {
		const dt = now - this.lastAdvance;
		this.lastAdvance = now;
		if (this.tween.active || !this.finalFraming) {
			this.prevView = null;
			this.spring = { azimuth: 0, polar: 0 };
			return false;
		}
		const bounds = rotationBounds(this.finalFraming);
		const put = (v: Framing): void => {
			this.camera.position.set(...v.position);
			this.camera.lookAt(this.controls.target);
		};
		let view = framingFromCamera(this.camera.position.toArray() as Vec3, this.controls.target.toArray() as Vec3);
		// Back inside the soft bounds after a mid-move grab: the plain limits, and the rubber band, again (even mid-drag).
		if (this.limitsWidened && withinBounds(view, bounds)) this.applyLimits(this.finalFraming, view);
		if (this.prevView && !this.limitsWidened) {
			const damped = rubberView(this.prevView, view, bounds);
			if (damped) { put(damped); view = damped; }
		}
		let busy = false;
		if (this.dragging) {
			this.spring = { azimuth: 0, polar: 0 };
		} else {
				const next = springToBounds(view, bounds, this.spring, dt);
			if (next) {
				put(next.view);
				view = next.view;
				this.spring = next.vel;
				busy = true;
			} else {
				this.spring = { azimuth: 0, polar: 0 };
			}
		}
		this.prevView = view;
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
		this.cancelRecentre();
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
