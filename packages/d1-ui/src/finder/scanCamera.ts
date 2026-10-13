// What the camera dialog needs to decide before and after asking for the camera, kept free of the
// DOM so it can be tested: whether the page can use a camera at all, and what an error means.

export interface CameraEnv {
	isSecureContext?: boolean;
	mediaDevices?: { getUserMedia?: unknown } | null;
}

export type CameraSupport = { ok: true } | { ok: false; message: string };

export const INSECURE_MESSAGE =
	'The camera only works on a secure (HTTPS) page. Open the database through the HTTPS address (the Tailscale one, https://d1-server.tail54eeb6.ts.net) instead of the plain-HTTP address.';

export function cameraSupport(env: CameraEnv): CameraSupport {
	// Browsers expose no mediaDevices on an insecure page, so this is checked first: it is the likely cause.
	if (env.isSecureContext === false) return { ok: false, message: INSECURE_MESSAGE };
	if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== 'function') {
		return { ok: false, message: `This browser cannot use the camera here. ${INSECURE_MESSAGE}` };
	}
	return { ok: true };
}

// A getUserMedia rejection in words.
export function cameraErrorMessage(err: unknown): string {
	const name = (err as { name?: string } | null)?.name;
	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return 'Camera permission was denied. Allow the camera for this site in the browser settings, then try again.';
		case 'NotFoundError':
		case 'OverconstrainedError':
			return 'No camera was found on this device.';
		case 'NotReadableError':
		case 'AbortError':
			return 'The camera is in use by another app. Close it and try again.';
		default:
			return 'The camera could not be started.';
	}
}

// Decode no more than about this often: a phone camera gives 30 frames a second and jsQR on each
// is wasted battery.
export const DECODE_INTERVAL_MS = 120;
// Frames are shrunk to at most this wide before decoding.
export const DECODE_MAX_WIDTH = 640;

export function decodeSize(width: number, height: number): { width: number; height: number } {
	if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
	if (width <= DECODE_MAX_WIDTH) return { width, height };
	return { width: DECODE_MAX_WIDTH, height: Math.round((height * DECODE_MAX_WIDTH) / width) };
}
