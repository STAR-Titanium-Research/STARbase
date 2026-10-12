import { onBeforeUnmount, ref } from 'vue';
import jsQR from 'jsqr';
import { cameraErrorMessage, cameraSupport, DECODE_INTERVAL_MS, decodeSize } from '@d1/ui';

// The rear camera of a phone, decoded frame by frame with jsQR. The decoding rule (how often, how
// big) and the messages are in @d1/ui (tested); this is the browser glue.
//
// start() asks for the camera and calls onText with the first QR code's text, then stops by itself:
// what to do with the text is the dialog's business, and it restarts with start() to scan again.
// stop() releases the camera (every track) and is also called when the component unmounts.

export type CameraState = 'idle' | 'starting' | 'scanning' | 'error';

export function useQrCamera(onText: (text: string) => void) {
	const video = ref<HTMLVideoElement | null>(null);
	const state = ref<CameraState>('idle');
	const error = ref('');

	let stream: MediaStream | null = null;
	let frame = 0;
	// Bumped by every start() and stop(): an await that finds it changed belongs to a camera nobody wants any more.
	let session = 0;
	let canvas: HTMLCanvasElement | null = null;
	let lastDecode = 0;

	function release(): void {
		cancelAnimationFrame(frame);
		frame = 0;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		const v = video.value;
		if (v) v.srcObject = null;
	}

	function stop(): void {
		session++;
		release();
		if (state.value !== 'error') state.value = 'idle';
	}

	function fail(message: string): void {
		release();
		error.value = message;
		state.value = 'error';
	}

	function tick(now: number, mine: number): void {
		if (mine !== session) return;
		frame = requestAnimationFrame((t) => tick(t, mine));
		const v = video.value;
		if (!v || now - lastDecode < DECODE_INTERVAL_MS || v.readyState < 2) return;
		lastDecode = now;
		const { width, height } = decodeSize(v.videoWidth, v.videoHeight);
		if (!width) return;
		canvas ??= document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return;
		ctx.drawImage(v, 0, 0, width, height);
		const found = jsQR(ctx.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' });
		if (found?.data) {
			stop();
			onText(found.data);
		}
	}

	async function start(): Promise<void> {
		stop();
		state.value = 'idle';
		const mine = session;
		error.value = '';
		const support = cameraSupport({ isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices });
		if (!support.ok) return fail(support.message);
		state.value = 'starting';
		let s: MediaStream;
		try {
			s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
		} catch (err) {
			if (mine === session) fail(cameraErrorMessage(err));
			return;
		}
		if (mine !== session) {
			// closed while the permission prompt was open
			s.getTracks().forEach((t) => t.stop());
			return;
		}
		stream = s;
		const v = video.value;
		if (!v) return fail('The camera could not be started.');
		v.srcObject = s;
		try {
			// iOS Safari needs playsinline (set on the element) and muted to start without a tap.
			await v.play();
		} catch {
			if (mine === session) fail('The camera could not be started.');
			return;
		}
		if (mine !== session) return;
		state.value = 'scanning';
		lastDecode = 0;
		frame = requestAnimationFrame((t) => tick(t, mine));
	}

	onBeforeUnmount(stop);

	return { video, state, error, start, stop };
}
