// Everything drawn for one tool box: the tray, a state ring per pocket, the inserts (instanced, one geometry),
// an edge segment per placed edge, and the highlights. Built once per model; `sync()` re-poses it for the
// current focus, hover and lifts. Imperative and outside Vue reactivity.

import {
	BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, type Intersection, type Object3D,
} from 'three';
import type { EdgePlacement, ToolingEdge, ToolingFocus, ToolingModel } from '@d1/ui';
import {
	buildInsertGeometry, buildReferenceMark, createEdgeSegments, edgeAnchor, EdgeGeometryCache,
} from './insertMesh';
import type { SceneMaterials } from './materials';
import type { LabelSpec, LabelTone } from './labels';
import {
	ghostInserts, partitionInstances, pickFromInstance, pickFromUserData, type PickTarget,
} from './pick';
import { buildPocketRingGeometry, buildTrayGeometry, slotLabelAnchor, slotPosition, trayLayout, type TrayLayout } from './trayMesh';
import type { Vec3 } from './cameraRig';

const SELECTED_RADIUS_MM = 0.36;
const HOVER_RADIUS_MM = 0.3;
const HALO_RADIUS_MM = 0.62;
const PICK_RADIUS_MM = 1.1; // fat invisible tubes: an edge is easy to aim at
const PICK_LAYER = 1; // never rendered, only raycast

export interface ViewState {
	focus: ToolingFocus;
	lifts: ReadonlyMap<string, number>; // how far each insert is raised out of its pocket, mm
	hover: PickTarget | null;
	nextFresh: { insertId: string; edgeId: string } | null;
	pulse: number; // 0..1, the next-fresh halo's brightness
}

interface EdgeItem { insertId: string; edge: ToolingEdge; mesh: Mesh; pick: Mesh }

const stateTone = (s: string): LabelTone => (s === 'fresh' ? 'ok' : s === 'partly-used' ? 'warn' : 'dim');

export class BoxView {
	readonly root = new Group();
	readonly layout: TrayLayout;
	private readonly geometries: BufferGeometry[] = [];
	private readonly cache: EdgeGeometryCache;
	private readonly pickMaterial = new MeshBasicMaterial({ visible: false });
	private readonly solid: InstancedMesh;
	private readonly ghost: InstancedMesh;
	private readonly marks: InstancedMesh;
	private readonly rings = new Map<string, Mesh>();
	private readonly edges: EdgeItem[] = [];
	private readonly selected: Mesh;
	private readonly hovered: Mesh;
	private readonly halo: Mesh;
	private solidIds: string[] = [];
	private ghostIds: string[] = [];
	private readonly m = new Matrix4();

	constructor(readonly model: ToolingModel, private readonly mats: SceneMaterials) {
		this.layout = trayLayout(model);
		const own = <T extends BufferGeometry>(g: T): T => { this.geometries.push(g); return g; };
		const n = Math.max(1, model.inserts.length);

		this.root.add(new Mesh(own(buildTrayGeometry(this.layout)), mats.tray));

		const ringGeo = own(buildPocketRingGeometry(this.layout));
		for (const i of model.inserts) {
			const slot = this.layout.slotOf.get(i.id);
			if (!slot) continue;
			const ring = new Mesh(ringGeo, mats.ring[i.state]);
			const c = this.layout.centre(slot.column, slot.row);
			ring.position.set(c.x, 0, c.z);
			ring.userData = { kind: 'insert', insertId: i.id };
			this.rings.set(i.id, ring);
			this.root.add(ring);
		}

		const bodyGeo = own(buildInsertGeometry(model.geometry, model.outline));
		const markGeo = own(buildReferenceMark(model.geometry, model.outline));
		this.solid = new InstancedMesh(bodyGeo, mats.body, n);
		this.ghost = new InstancedMesh(bodyGeo, mats.bodyGhost, n);
		this.marks = new InstancedMesh(markGeo, mats.mark, n);
		this.ghost.renderOrder = 2;
		for (const im of [this.solid, this.ghost, this.marks]) {
			im.count = 0;
			im.frustumCulled = false;
			this.root.add(im);
		}

		this.cache = new EdgeGeometryCache(model.geometry, model.outline);
		for (const insert of model.inserts) {
			const visible = createEdgeSegments(insert, this.cache, mats.edge.fresh);
			const picks = createEdgeSegments(insert, this.cache, this.pickMaterial, PICK_RADIUS_MM);
			visible.forEach((mesh, k) => {
				const pick = picks[k];
				pick.layers.set(PICK_LAYER);
				this.root.add(mesh, pick);
				const edge = insert.edges.find((e) => e.id === (mesh.userData as { edgeId: string }).edgeId)!;
				this.edges.push({ insertId: insert.id, edge, mesh, pick });
			});
		}

		this.selected = new Mesh(undefined, mats.edge.selected);
		this.hovered = new Mesh(undefined, mats.edge.hover);
		this.halo = new Mesh(undefined, mats.edge.halo);
		for (const h of [this.selected, this.hovered, this.halo]) { h.visible = false; h.renderOrder = 3; this.root.add(h); }
		this.halo.renderOrder = 4;
	}

	// The centre of an insert (mid-thickness), raised by `lift`.
	insertCentre(insertId: string, lift = 0): Vec3 {
		const slot = this.layout.slotOf.get(insertId);
		if (!slot) return [0, this.layout.insertY + lift, 0];
		const p = slotPosition(this.layout, slot);
		return [p.x, p.y + lift, p.z];
	}

	placementOf(edgeId: string): EdgePlacement | null {
		return this.edges.find((e) => e.edge.id === edgeId)?.edge.placement ?? null;
	}

	private place(obj: Object3D, insertId: string, lift: number): void {
		const c = this.insertCentre(insertId, lift);
		obj.position.set(c[0], c[1], c[2]);
	}

	private overlay(mesh: Mesh, edgeId: string | null, radius: number, insertId: string, lift: number): void {
		const placement = edgeId ? this.placementOf(edgeId) : null;
		if (!placement) { mesh.visible = false; return; }
		mesh.geometry = this.cache.get(placement, radius);
		this.place(mesh, insertId, lift);
		mesh.visible = true;
	}

	sync(state: ViewState): void {
		const { focus, lifts, hover } = state;
		const ghostSet = ghostInserts(this.model, focus);
		const ids = this.model.inserts.map((i) => i.id);
		const split = partitionInstances(ids, ghostSet);
		this.solidIds = split.solid;
		this.ghostIds = split.ghost;
		const lift = (id: string) => lifts.get(id) ?? 0;
		const fill = (mesh: InstancedMesh, list: string[]) => {
			mesh.count = list.length;
			list.forEach((id, k) => {
				const c = this.insertCentre(id, lift(id));
				mesh.setMatrixAt(k, this.m.makeTranslation(c[0], c[1], c[2]));
			});
			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();
		};
		fill(this.solid, split.solid);
		fill(this.ghost, split.ghost);
		fill(this.marks, split.solid);

		const focusInsert = focus.kind === 'box' ? null : focus.insertId;
		for (const i of this.model.inserts) {
			const ring = this.rings.get(i.id);
			if (!ring) continue;
			const hovered = hover !== null && hover.insertId === i.id && hover.kind === 'insert';
			ring.material = this.mats.ring[focusInsert === i.id ? 'selected' : hovered ? 'hover' : i.state];
		}

		for (const e of this.edges) {
			this.place(e.mesh, e.insertId, lift(e.insertId));
			this.place(e.pick, e.insertId, lift(e.insertId));
			const g = ghostSet.has(e.insertId);
			const tone = e.edge.used ? (g ? 'usedGhost' : 'used') : (g ? 'freshGhost' : 'fresh');
			e.mesh.material = this.mats.edge[tone];
		}

		const selEdge = focus.kind === 'edge' ? focus.edgeId : null;
		const selInsert = focus.kind === 'edge' ? focus.insertId : '';
		this.overlay(this.selected, selEdge, SELECTED_RADIUS_MM, selInsert, lift(selInsert));
		const hoverEdge = hover?.kind === 'edge' && hover.edgeId !== selEdge ? hover : null;
		this.overlay(this.hovered, hoverEdge ? hoverEdge.edgeId : null, HOVER_RADIUS_MM, hoverEdge?.insertId ?? '', hoverEdge ? lift(hoverEdge.insertId) : 0);
		const next = state.nextFresh && state.nextFresh.edgeId !== selEdge ? state.nextFresh : null;
		this.overlay(this.halo, next ? next.edgeId : null, HALO_RADIUS_MM, next?.insertId ?? '', next ? lift(next.insertId) : 0);
		this.mats.edge.halo.opacity = 0.3 + 0.5 * state.pulse;
	}

	// Meshes a click or hover can hit: the inserts and their rings, and the fat edge tubes of the focused insert.
	pickables(focus: ToolingFocus): Object3D[] {
		const list: Object3D[] = [this.solid, this.ghost, ...this.rings.values()];
		if (focus.kind !== 'box') for (const e of this.edges) if (e.insertId === focus.insertId) list.push(e.pick);
		return list;
	}

	resolve(hit: Intersection, focus: ToolingFocus): PickTarget | null {
		if (hit.object === this.solid) return pickFromInstance(this.solidIds, hit.instanceId);
		if (hit.object === this.ghost) return pickFromInstance(this.ghostIds, hit.instanceId);
		return pickFromUserData(hit.object.userData, focus);
	}

	// The pills for a focus: slot numbers at box level, edge letters at insert and edge level.
	labels(focus: ToolingFocus): LabelSpec[] {
		const out: LabelSpec[] = [];
		if (focus.kind === 'box') {
			for (const slot of this.layout.slots) {
				const insert = this.model.inserts.find((i) => i.id === slot.insertId);
				out.push({
					key: `slot:${slot.column}:${slot.row}`, text: slot.label, anchor: slotLabelAnchor(this.layout, slot),
					tone: insert ? stateTone(insert.state) : 'none',
					target: insert ? { kind: 'insert', insertId: insert.id } : null,
					title: insert ? `Insert ${slot.label}, ${insert.state.replace('-', ' ')}` : `Slot ${slot.label}, empty`,
				});
			}
			return out;
		}
		const insert = this.model.inserts.find((i) => i.id === focus.insertId);
		if (!insert) return out;
		for (const e of insert.edges) {
			if (!e.placement || !e.letter) continue;
			const a = edgeAnchor(this.model.geometry, this.model.outline, e.placement);
			const c = this.insertCentre(insert.id);
			out.push({
				key: `edge:${e.id}`, text: e.letter, insertId: insert.id,
				anchor: [c[0] + a[0], c[1] + a[1], c[2] + a[2]] as [number, number, number],
				tone: e.used ? 'dim' : 'ok',
				selected: focus.kind === 'edge' && focus.edgeId === e.id,
				target: { kind: 'edge', insertId: insert.id, edgeId: e.id },
				title: `Edge ${e.letter}, ${e.used ? 'used' : 'fresh'}${e.placement.face === 'bottom' ? ', underside' : ''}`,
			});
		}
		return out;
	}

	dispose(): void {
		this.root.removeFromParent();
		for (const g of this.geometries) g.dispose();
		this.cache.dispose();
		this.pickMaterial.dispose();
		for (const im of [this.solid, this.ghost, this.marks]) im.dispose();
		this.root.clear();
	}
}
