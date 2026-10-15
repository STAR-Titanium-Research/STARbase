// Inserts rise out of their pockets: the focused one all the way (LIFT_MM), a hovered one a little (HOVER_LIFT_MM).
// Each insert has its own lift that eases on its own, so several can be moving at once. Pure and time based, so the
// motion is the same at any frame rate; the scene just asks `sample(now)` each frame.

import type { ToolingFocus } from '@d1/ui';
import { easeInOutCubic, easeOutCubic, FLIGHT_MS, HOVER_DOWN_MS, HOVER_UP_MS, motionMs, type Ease } from './motion';
import type { PickTarget } from './pick';

export const LIFT_MM = 9;
export const HOVER_LIFT_MM = 2.2;

// The lift (mm) each insert is heading for: the focused insert at the full lift, and a hovered insert (the pointer
// is over its body, its pocket or its number) at the hover lift unless it is already higher. Everything else is 0.
export function liftTargets(focus: ToolingFocus, hover: PickTarget | null = null): Map<string, number> {
	const out = new Map<string, number>();
	if (hover && hover.kind === 'insert') out.set(hover.insertId, HOVER_LIFT_MM);
	if (focus.kind !== 'box') out.set(focus.insertId, LIFT_MM);
	return out;
}

// How a move of one insert's lift from `from` to `to` goes. The full lift or drop (anything past the hover height) takes
// the camera flight's duration and ease, so the insert rises in step with the camera. A hover rise is quick and a settle
// back a little slower, both eased out; one that covers only part of the way is shorter, so reversing never drags.
export function liftTiming(from: number, to: number, reduced?: boolean): { ms: number; ease: Ease } {
	if (Math.max(from, to) > HOVER_LIFT_MM + 1e-6) return { ms: motionMs(FLIGHT_MS, reduced), ease: easeInOutCubic };
	const share = Math.min(1, Math.max(0.4, Math.abs(to - from) / HOVER_LIFT_MM));
	return { ms: motionMs(to > from ? HOVER_UP_MS : HOVER_DOWN_MS, reduced) * share, ease: easeOutCubic };
}

interface Move { from: number; to: number; t0: number; ms: number; ease: Ease }

const at = (m: Move, now: number): number => m.from + (m.to - m.from) * m.ease((now - m.t0) / m.ms);

export class LiftMotion {
	private readonly moves = new Map<string, Move>();
	private readonly rest = new Map<string, number>(); // inserts not moving, and where they sit (absent: in the pocket)

	/** Whether any insert is still on its way. */
	get moving(): boolean { return this.moves.size > 0; }

	private valueAt(id: string, now: number): number {
		const m = this.moves.get(id);
		return m ? at(m, now) : (this.rest.get(id) ?? 0);
	}

	/**
	 * Heads each insert for its target from where it is now (an insert absent from `targets` is heading for 0). A move
	 * under way that already goes to the new target is left alone; one that does not is replaced by a new move from the
	 * in-between value, so a change of mind chains without a jump. `instant` puts every insert there at once.
	 */
	retarget(targets: ReadonlyMap<string, number>, now: number, opts: { instant?: boolean; reduced?: boolean } = {}): void {
		for (const id of new Set([...this.moves.keys(), ...this.rest.keys(), ...targets.keys()])) {
			const to = targets.get(id) ?? 0;
			const move = this.moves.get(id);
			if (opts.instant) {
				this.moves.delete(id);
				if (to !== 0) this.rest.set(id, to);
				else this.rest.delete(id);
				continue;
			}
			if (move ? move.to === to : (this.rest.get(id) ?? 0) === to) continue;
			const from = this.valueAt(id, now);
			const { ms, ease } = liftTiming(from, to, opts.reduced);
			this.rest.delete(id);
			this.moves.set(id, { from, to, t0: now, ms, ease });
		}
	}

	/** The lift of every insert that is out of its pocket, at `now`. Finished moves settle. */
	sample(now: number): Map<string, number> {
		for (const [id, m] of this.moves) {
			if (now - m.t0 < m.ms) continue;
			this.moves.delete(id);
			if (m.to !== 0) this.rest.set(id, m.to);
		}
		const out = new Map<string, number>(this.rest);
		for (const [id, m] of this.moves) out.set(id, at(m, now));
		return out;
	}
}
