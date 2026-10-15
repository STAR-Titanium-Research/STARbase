// Keyboard for the surface view. OrbitControls' own arrow keys only pan, and the surface view has no pan, so the keys
// are wired here: the arrow keys turn the surface (left and right around it, up and down towards the top view), plus
// and minus zoom. Pure: the scene reads the camera, asks for the next state and writes it back.

export interface OrbitState {
	/** Radians around the vertical axis. */
	azimuth: number;
	/** Radians from straight above (0) towards the horizon. */
	polar: number;
	distance: number;
}

export interface OrbitLimits {
	minPolar: number;
	maxPolar: number;
	minDistance: number;
	maxDistance: number;
}

export const KEY_TURN_RAD = (6 * Math.PI) / 180;
export const KEY_ZOOM = 0.85;
export const ORBIT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'] as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The state after this key, or null when the key is not one of the view's. */
export function keyStep(key: string, s: OrbitState, lim: OrbitLimits): OrbitState | null {
	let { azimuth, polar, distance } = s;
	switch (key) {
		case 'ArrowLeft': azimuth -= KEY_TURN_RAD; break;
		case 'ArrowRight': azimuth += KEY_TURN_RAD; break;
		case 'ArrowUp': polar -= KEY_TURN_RAD; break; // the camera rises: a more top-down view
		case 'ArrowDown': polar += KEY_TURN_RAD; break;
		case '+': case '=': distance *= KEY_ZOOM; break;
		case '-': case '_': distance /= KEY_ZOOM; break;
		default: return null;
	}
	return { azimuth, polar: clamp(polar, lim.minPolar, lim.maxPolar), distance: clamp(distance, lim.minDistance, lim.maxDistance) };
}

/** Camera position (relative to the target) of a state: x right, y up, z towards the viewer. */
export function orbitPosition(s: OrbitState): [number, number, number] {
	return [s.distance * Math.sin(s.polar) * Math.sin(s.azimuth), s.distance * Math.cos(s.polar), s.distance * Math.sin(s.polar) * Math.cos(s.azimuth)];
}

/** The state of a camera at this position relative to its target. */
export function orbitState(x: number, y: number, z: number): OrbitState {
	const distance = Math.hypot(x, y, z);
	return { azimuth: Math.atan2(x, z), polar: distance > 0 ? Math.acos(clamp(y / distance, -1, 1)) : 0, distance };
}
