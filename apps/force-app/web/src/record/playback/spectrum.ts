// Playback FFT transport. Spectra are computed by the recorder sidecar's /dsp/spectrum, which
// runs the SAME scipy welch_spectra() the live recording path uses — so a replayed cut's FFT is
// bit-identical to a live one's rather than a second implementation that could drift.
//
// Two behaviours make a few-per-second call affordable while scrubbing:
//   throttle  — at most one call per minIntervalMs (300 by default, matching the backend's own
//               live-FFT throttle in session._update_fft)
//   coalesce  — while a call is in flight only the NEWEST pending request survives, so dragging
//               the scrub bar can never build a queue of stale windows to work through.

export interface SpectrumReply { fs: number; f: number[]; spectra: Record<string, number[]> }
export interface SpectrumRequest {
	fs: number;
	names: string[];
	// channel-major, names.length * n. Must span its whole backing buffer (byteOffset 0, no
	// trailing bytes) — pump() posts `samples.buffer` directly rather than copying, since the one
	// caller (engine.ts) always allocates a fresh exact-length Float32Array per request. A
	// subarray view of a larger buffer would post extra bytes past the intended window.
	samples: Float32Array;
	nperseg?: number;
	force?: boolean;         // bypass the throttle (scrub release)
}
export interface SpectrumClient {
	request(req: SpectrumRequest): void;
	// Whether request() would take a request right now -- lets a caller skip building a large
	// samples buffer that the throttle would only discard.
	wouldAccept(force?: boolean): boolean;
	onReply: (r: SpectrumReply) => void;
	onError: (e: Error) => void;
	flush(): Promise<void>;  // settle all in-flight + pending work (tests, and dispose)
	dispose(): void;
}

export function createSpectrumClient(baseUrl: string, opts: { minIntervalMs?: number } = {}): SpectrumClient {
	const minInterval = opts.minIntervalMs ?? 300;
	let pending: SpectrumRequest | null = null;
	let inFlight: Promise<void> | null = null;
	let lastSent = -Infinity;
	let disposed = false;

	const c: SpectrumClient = {
		onReply: () => {},
		onError: () => {},
		request(req) {
			if (disposed) return;
			// The throttle applies whether or not a call is in flight. Exempting the in-flight case
			// defeated it entirely: during playback there is essentially always one in flight, so
			// requests went out back-to-back at round-trip rate with ~300 KB bodies each.
			if (!c.wouldAccept(req.force)) return;
			pending = req;                       // newest wins; an older pending one is discarded
			if (!inFlight) inFlight = pump();
		},
		wouldAccept(force) {
			return !disposed && (!!force || performance.now() - lastSent >= minInterval);
		},
		async flush() {
			while (inFlight) await inFlight;
		},
		dispose() { disposed = true; pending = null; },
	};

	async function pump(): Promise<void> {
		while (pending && !disposed) {
			const req = pending;
			pending = null;
			lastSent = performance.now();
			try {
				const q = new URLSearchParams({ fs: String(req.fs), names: req.names.join(',') });
				if (req.nperseg) q.set('nperseg', String(req.nperseg));
				const res = await fetch(`${baseUrl}/dsp/spectrum?${q}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/octet-stream' },
					// Cast because .buffer is ArrayBufferLike (it could be a SharedArrayBuffer, which
					// is not a BodyInit). The contract on SpectrumRequest.samples guarantees a plain,
					// exactly-sized ArrayBuffer here.
					body: req.samples.buffer as ArrayBuffer,
				});
				if (!res.ok) throw new Error(`spectrum: ${res.status} ${(await res.text()).slice(0, 200)}`);
				if (!disposed) c.onReply(await res.json());
			} catch (e: any) {
				if (!disposed) c.onError(e instanceof Error ? e : new Error(String(e)));
			}
		}
		inFlight = null;
	}

	return c;
}
