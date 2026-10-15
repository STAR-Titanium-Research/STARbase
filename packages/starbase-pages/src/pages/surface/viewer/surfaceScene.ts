// The 3D view of one surface scan. Imperative and outside Vue reactivity, like the tooling stage's scene
// (pages/tooling/stage/scene): SurfaceScanViewer.vue loads this module with a dynamic import() so three.js stays
// out of the entry chunk. Render on demand: a frame is drawn when the exaggeration, the colour mode, the size or
// the camera changed, and nothing runs at rest. Orbit and zoom only (no pan, no picking, no measuring).

import {
	ClampToEdgeWrapping, DataTexture, DoubleSide, FloatType, LinearFilter, Mesh, NearestFilter, PerspectiveCamera, PlaneGeometry, RGBAFormat,
	RGFormat, Scene, ShaderMaterial, UnsignedByteType, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { rampBytes } from './colourRamp';
import { ScanDataError } from './gridData';
import { keyStep, orbitPosition, orbitState } from './orbitKeys';
import type { PreparedScan } from './prepareScan';
import { FOV_DEG, frameCamera, type CameraFrame } from './scanLayout';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './surfaceShaders';

const RAD = Math.PI / 180;

export class SurfaceScene {
	private readonly renderer: WebGLRenderer;
	private readonly scene = new Scene();
	private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.01, 100);
	private readonly controls: OrbitControls;
	private readonly geometry: PlaneGeometry;
	private readonly material: ShaderMaterial;
	private readonly gridTexture: DataTexture;
	private readonly rampTexture: DataTexture;
	private frame: CameraFrame;
	private raf = 0;
	private dirty = true;
	private disposed = false;
	private lostCb: (() => void) | null = null;
	private readonly onLost = (e: Event) => { e.preventDefault(); this.lostCb?.(); };

	constructor(private readonly canvas: HTMLCanvasElement, private readonly prepared: PreparedScan) {
		const { meta, texture, layout, range } = prepared;
		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
		this.renderer.setClearColor(0x000000, 0);
		const max = this.renderer.capabilities.maxTextureSize;
		if (meta.width > max || meta.height > max) {
			try { this.renderer.forceContextLoss(); } catch { /* already gone */ } // do not leave a live context behind
			this.renderer.dispose();
			throw new ScanDataError(`This graphics card cannot hold a ${meta.width} × ${meta.height} texture.`);
		}

		// The height grid: RG32F, nearest, read with texelFetch (no filtering of float textures is needed or wanted).
		this.gridTexture = new DataTexture(texture.data, meta.width, meta.height, RGFormat, FloatType);
		this.gridTexture.minFilter = NearestFilter;
		this.gridTexture.magFilter = NearestFilter;
		this.gridTexture.generateMipmaps = false;
		this.gridTexture.wrapS = this.gridTexture.wrapT = ClampToEdgeWrapping;
		this.gridTexture.needsUpdate = true;

		this.rampTexture = new DataTexture(rampBytes(256), 256, 1, RGBAFormat, UnsignedByteType);
		this.rampTexture.minFilter = LinearFilter;
		this.rampTexture.magFilter = LinearFilter;
		this.rampTexture.generateMipmaps = false;
		this.rampTexture.wrapS = this.rampTexture.wrapT = ClampToEdgeWrapping;
		this.rampTexture.needsUpdate = true;

		const pitchX = meta.pixelPitchXUm ?? 1;
		const pitchZ = meta.pixelPitchYUm ?? pitchX;
		this.material = new ShaderMaterial({
			vertexShader: VERTEX_SHADER,
			fragmentShader: FRAGMENT_SHADER,
			side: DoubleSide,
			uniforms: {
				uGrid: { value: this.gridTexture },
				uRamp: { value: this.rampTexture },
				uCells: { value: new Vector2(meta.width, meta.height) },
				uScene: { value: new Vector3(layout.sizeX, layout.sizeZ, layout.umToScene) },
				uPitch: { value: new Vector2(pitchX, pitchZ) },
				uExag: { value: prepared.initialExaggeration },
				uZMid: { value: (range.min + range.max) / 2 },
				uZMin: { value: range.min },
				uZRange: { value: range.max - range.min },
				uColour: { value: 1 },
			},
		});
		// One vertex per cell; the vertex shader places them, so the plane's own size is irrelevant.
		this.geometry = new PlaneGeometry(1, 1, meta.width - 1, meta.height - 1);
		const mesh = new Mesh(this.geometry, this.material);
		mesh.frustumCulled = false; // its real bounds come from the texture, which the CPU does not look at again
		this.scene.add(mesh);

		this.frame = frameCamera(layout, range, prepared.initialExaggeration, 1.5);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enablePan = false;
		this.controls.enableDamping = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
		this.controls.dampingFactor = 0.12;
		this.controls.rotateSpeed = 0.7;
		this.controls.zoomSpeed = 0.8;
		this.controls.addEventListener('change', this.request);
		canvas.addEventListener('webglcontextlost', this.onLost);
		canvas.addEventListener('keydown', this.onKey);
		this.resize(); // the camera's aspect first: the opening view is framed for the real size of the canvas
		this.applyFrame();
	}

	// Arrow keys turn the surface and plus / minus zoom, with the canvas focused (OrbitControls' own keys only pan).
	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const t = this.controls.target;
		const p = this.camera.position;
		const next = keyStep(e.key, orbitState(p.x - t.x, p.y - t.y, p.z - t.z), {
			minPolar: this.controls.minPolarAngle,
			maxPolar: this.controls.maxPolarAngle,
			minDistance: this.controls.minDistance,
			maxDistance: this.controls.maxDistance,
		});
		if (!next) return;
		e.preventDefault();
		const [x, y, z] = orbitPosition(next);
		this.camera.position.set(t.x + x, t.y + y, t.z + z);
		this.controls.update();
		this.request();
	};

	// ---- inputs from the viewer -------------------------------------------------------------------------

	setExaggeration(x: number): void {
		this.material.uniforms.uExag.value = x;
		this.request();
	}

	setColourByHeight(on: boolean): void {
		this.material.uniforms.uColour.value = on ? 1 : 0;
		this.request();
	}

	/** Back to the opening view, for the current aspect. */
	resetView(): void {
		this.applyFrame();
		this.request();
	}

	onContextLost(cb: () => void): void {
		this.lostCb = cb;
	}

	resize(): void {
		if (this.disposed) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w <= 0 || h <= 0) return;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.request();
	}

	// ---- camera ---------------------------------------------------------------------------------------

	private applyFrame(): void {
		const aspect = this.camera.aspect || 1.5;
		this.frame = frameCamera(this.prepared.layout, this.prepared.range, this.prepared.initialExaggeration, aspect);
		const f = this.frame;
		this.camera.near = f.near;
		this.camera.far = f.far;
		this.camera.updateProjectionMatrix();
		const phi = f.polarDeg * RAD;
		const theta = f.azimuthDeg * RAD;
		this.camera.position.set(f.distance * Math.sin(phi) * Math.sin(theta), f.distance * Math.cos(phi), f.distance * Math.sin(phi) * Math.cos(theta));
		this.controls.target.set(0, 0, 0);
		this.controls.minDistance = f.minDistance;
		this.controls.maxDistance = f.maxDistance;
		this.controls.minPolarAngle = f.minPolarDeg * RAD;
		this.controls.maxPolarAngle = f.maxPolarDeg * RAD;
		this.controls.update();
	}

	// ---- on-demand rendering --------------------------------------------------------------------------

	private readonly request = (): void => {
		this.dirty = true;
		this.schedule();
	};

	private schedule(): void {
		if (this.raf || this.disposed) return;
		this.raf = requestAnimationFrame(this.tick);
	}

	private readonly tick = (): void => {
		this.raf = 0;
		if (this.disposed) return;
		const moving = this.controls.update(); // damping: true while it is still coasting
		if (this.dirty || moving) {
			this.dirty = false;
			this.renderer.render(this.scene, this.camera);
		}
		if (moving) this.schedule();
	};

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.canvas.removeEventListener('webglcontextlost', this.onLost);
		this.canvas.removeEventListener('keydown', this.onKey);
		this.controls.removeEventListener('change', this.request);
		this.controls.dispose();
		this.geometry.dispose();
		this.material.dispose();
		this.gridTexture.dispose();
		this.rampTexture.dispose();
		this.scene.clear();
		try { this.renderer.forceContextLoss(); } catch { /* already gone */ } // browsers allow only a few live contexts
		this.renderer.dispose();
	}
}
