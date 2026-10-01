# Replay Playback Transport — Design

- **Date:** 2026-08-26
- **Area:** `apps/force-app` — Recording workspace, "Replay file" source
- **Status:** Implemented 2026-08-27 — `apps/force-app/web/src/record/playback/`,
  `TransportBar.vue` and `POST /dsp/spectrum`, with Playwright coverage in
  `apps/force-app/desktop/tests/replay-playback.spec.ts`

## Problem

The Recording workspace's "Replay file" source is meant to let an operator pull a past cut
out of Directus and watch it come back through the live viewers. In practice it does not
behave like a live cut, and it offers no way to control playback once started.

Two defects were reproduced against the current code.

**Live RPM is wrong by the decimation factor.** `ReplaySource` decimates a cut down to
~300k samples and streams at `fs / stride`, but `/record/start_replay` sets
`cfg.sample_rate` to the cache's *original* rate. Every consumer in `RecordingSession`
reads `source.rate` and is therefore correct — except `FrmIntegrator`, which takes its
`fs` from `cfg.sample_rate`. On a 60 s / 25 kHz cut (stride 5) the live RPM readout shows
7500 against a true 1500, while the finalized cut on disk is correct. Because the safety
alarm's threshold auto-defaults to `cfg.rpm × 1.02`, this fires the full-screen red SAFETY
ALARM overlay on every replay.

The FRM spiral itself survives this: `theta` accumulates `rpm × dt`, and the two errors
(`rpm` high by `stride`, `dt` low by `stride`) cancel exactly. Only the readout, the gauge
and the alarm are affected.

**Realtime pacing is ignored on anything but short cuts.** `ReplaySource.read()` caps its
per-chunk sleep at `min(dt, 0.1)`. The pacing target is absolute, so an under-sleep is
never repaid:

```
speed= 1.0x  played 9.0s of cut in 3.0s wall => effective 3.0x (asked 1.0x)
             a 120s cut takes 40s instead of 120s
speed=20.0x  effective 20.0x  (correct — short chunks stay under the cap)
```

Chunks are sized so a replay is ~400 of them regardless of length, so the effective floor
is ~40 s per replay however long the cut really is. The UI compounds this by defaulting
`replay.speed` to 20× with `min="1"`, so out of the box a 60 s cut blurs past in three
seconds and slow-motion cannot be selected at all.

Separately, `w.cfg` (rpm / feed / diam) is never populated from the picked cut, so the RPM
gauge's target and the alarm threshold keep the form's defaults even though
`pickReplayCut` already fetches the operation record carrying
`machining_spindle_speed_rpm`.

## Goal

Replaying an old file should behave like a video player: play, pause, and scrub freely in
both directions, at a speed the operator chooses, with the same viewers a real cut
drives — waveform, FFT, spectrogram, waterfall, FRM, RPM.

## Decisions

### Playback is a viewer, not a recording

Today a replay runs as a full `RecordingSession`: it writes `raw.d1raw`, finalizes a new
`capture.mat` and `live_cache.bin`, and opens the Save dialog so the result can be
uploaded to Directus as a *new* operation.

Playback drops all of that. Nothing is written to disk, nothing is finalized, the Save
dialog never opens.

This is what makes scrubbing possible at all. `RawWriter` is append-only and
`FrmIntegrator` carries `theta`/`rho` across chunks, so seeking backwards through a
recording session would either corrupt the capture or require unwinding integrator state
that was never designed to be unwound. Removing the capture removes the constraint.

The operator already has the cut — it is in Directus, which is where it was picked from.
Producing a second, near-identical copy of it every time someone wants to look at one was
never the point of the feature.

### The playhead is local; the DSP stays in Python

The browser already downloads the D1LC cache to hand to the backend. Playback parses it
locally with `parseCache` instead, runs the playhead in the browser, and fills the same
`client.trace` / `client.frm` / `client.fft` buffers that `RecordClient.onFrame` fills
from the WebSocket.

Every panel therefore works unchanged. Panels switch on `w.isDone` — false during
playback, so they render the live widgets, which is exactly the "live feed" look the
feature is for.

Seeking is cheap because both buffers are time-ordered. Scrubbing back is a `count` reset
and a tail drop; scrubbing forward appends the crossed range. Scrub latency is a memory
copy.

A further benefit falls out: because no session is opened, playback cannot collide with
the backend's single-session `_busy()` model, so an operator can review an old cut on a
machine that is mid-recording without either one disturbing the other.

Spectra stay in Python. There is no FFT in the frontend and there will not be one: every
spectral path in this repo is scipy — `session._update_fft` for live, the filter-service
`/fft` and `/spectrogram` for finished cuts — and a second implementation in TypeScript
would be a new source of disagreement for no gain.

Playback instead calls a new **stateless** `POST /dsp/spectrum` on the recorder sidecar:
send the current window, get back `f` plus per-channel spectra, computed by the same
`scipy.signal.welch` call `_update_fft` already makes. Playback's FFT is then bit-identical
to a live cut's rather than merely similar, which is the parity the feature was asked for.

The round-trip is affordable because the cadence is low. `_update_fft` already throttles
live spectra to roughly three per second (`now - _fft_last < 0.3`), and playback matches
that; a call to the bundled sidecar on localhost is single-digit milliseconds. Scrubbing
is debounced on drag release, so dragging the bar costs one request when it settles, not
one per frame.

This does mean playback needs the sidecar running. In the desktop bundle the sidecar ships
with the app and is started by it, so that is not a deployment that occurs in practice.

**Rejected: a *stateful* backend playback session** (`pause`/`resume`/`seek` on
`ReplaySource` behind a `/playback/*` surface, streaming over the WebSocket). Note this is
not a rejection of backend DSP — spectra are computed in Python either way. What is
rejected is putting the *playhead* on the server: it adds session state that fights the
single-session `_busy()` model, so reviewing an archived cut could block or be blocked by
a rig that is mid-recording. Keeping the playhead local and the DSP remote gets the scipy
parity without the coupling.

**Rejected: reusing the finished-cut components** (`ForceChart`, `FrmCloud`,
`SpectrumView`) fed a growing prefix. Least new code, and `SpectrumView` already covers
spectrogram and waterfall. But it looks like the plotting dashboard growing rather than a
live feed, which is not what was asked for.

### FRM geometry comes from the cache, not from integration

`liveCloud.ts` already derives FRM geometry directly from a cache's cumulative `revs`
array — `theta = 2πr`, `rho = D/2 − Feed·r`, with `r = (revs[i] − revs[cs]) / ppr` in
`measured` mode. The spiral at any playhead is therefore a pure function of the cache
prefix, with no carried state.

Playback reuses that formula rather than reimplementing `FrmIntegrator`'s incremental
version. This is the single reason scrubbing backwards is trivial rather than delicate,
and it keeps playback's spiral identical to the one the plotting dashboard draws for the
same cut.

### Playback mode is explicit in the workspace

`createWorkspace` gains `mode: 'record' | 'playback'`, derived from the selected source:
`replay` means playback, `sim` and `nidaq` mean recording.

In playback mode the Start/Stop buttons are replaced by the transport bar, `saveOpen`
never fires, `checkDiskBeforeStart` is not consulted, and the alarm controller is not
evaluated — an old cut cannot trip a safety alarm on a machine that is not cutting.

Making the mode explicit rather than testing `source.value === 'replay'` at each site
keeps the branch in one place and makes the "playback writes nothing" guarantee auditable.

### Playback applies no filter chain

The `FilterChain` (despike / detrend / highpass / lowpass / notch) stays where it is today:
on finished cuts in the plotting dashboard, via the filter-service. Live recording applies
no chain, so neither does playback. An archived cut therefore looks in playback exactly as
it looked while it was being recorded, which is the whole point.

Auditioning filter settings against a moving playhead is a reasonable thing to want later,
but the chain is cache-file-oriented in the filter-service and would need new plumbing to
apply to a moving window. Out of scope here.

## Components

Three new units, each usable and testable on its own.

| Unit | Responsibility | Depends on |
|---|---|---|
| `record/playback/spectrum.ts` | Thin client for `POST /dsp/spectrum`: window in, `f` + spectra out. Debounce and in-flight coalescing live here. | recorder sidecar |
| `record/playback/engine.ts` | Owns the parsed `Cache` and the playhead. `play` / `pause` / `seek` / `setSpeed`. Fills a `RecordClient`'s buffers for a given playhead. | `liveCache`, `liveCloud`, `spectrum` |
| `record/panels/TransportBar.vue` | Play/pause button, scrub bar, `0:24 / 1:02` readout, speed control. | `engine` |

`engine.ts` takes a `RecordClient` and writes to its buffers. It does not own rendering
and does not know about Vue components; the panels observe `client.frameSeq` exactly as
they do for a live recording.

## Data flow

Picking a cut downloads the asset and parses it into a `Cache` the engine holds. From
there the only backend traffic is the throttled `/dsp/spectrum` call; the waveform, FRM and
RPM views are served entirely from the parsed cache.

`play()` advances the playhead on `requestAnimationFrame` by `dt × speed`. Each tick:

1. Appends the newly-crossed samples to `client.trace` as a min/max envelope, in the same
   `(bins, 7)` shape `Decimator.process` emits, then drops points older than
   `windowSec` — the same trim `onFrame` performs.
2. Appends the crossed FRM points to `client.frm`, geometry from the `liveCloud` formula.
   The spiral origin is the cache's own `csSec` (detected cut start), matching what
   `FrmCloud` draws for the same cut, so playback and the plotting dashboard agree
   point-for-point. Samples before `csSec` contribute no points.
3. Updates `client.status` — `tSec`, `rpm` (read from the cache's own `rpm` array, not
   re-derived), and running `peaks`.
4. Requests a spectrum for the trailing window (throttled to ~3/s, matching
   `_update_fft`) and assigns the reply to `client.fft`, appending to `client.fftHistory`
   exactly as `onControl`'s `fft` branch does. Requests coalesce: a window is never
   queued behind a stale one.
5. Bumps `client.frameSeq`.

`seek(t)` truncates `trace` and `frm` to `t` and refills from the cache. Because points
are time-ordered, truncation is a slice and a `count` assignment.

`setSpeed(x)` accepts values below 1 for slow-motion. The default is 1×, so playback is
true realtime unless asked otherwise. The speed input's `min` changes from `1` to `0.1`
and offers preset steps (0.25×, 0.5×, 1×, 2×, 5×, 10×, 20×); the current `min="1"` is
half of why replay never looked live.

## Error handling

A cut whose asset download or `parseCache` fails leaves the engine unloaded and surfaces
the reason in `errMsg`, the same field the recording path already uses; the transport bar
stays disabled. A cache with fewer than two samples, or a zero/absent `Fs`, is treated as
unplayable and reported rather than divided by. Seeks are clamped to `[0, duration]`.

If `/dsp/spectrum` is unreachable, the waveform, FRM and RPM views keep playing — they need
no backend — and only the spectral panels show an unavailable state. Playback degrades to
the views that still have data rather than stopping.

## Known limits

Both are inherent to the D1LC cache and will be stated in the UI rather than papered over.

**Sub-channels are synthetic.** The cache carries summed Fx/Fy/Fz only. The per-sensor
plots (Fx1…Fz4) will show the same synthetic split the backend's `ReplaySource` already
applies — `Fx/2`, `Fy/2`, `Fz/4`. Real per-sensor data exists only in the `.mat`.

Tacho is the ninth entry in `SUB_NAMES` and has no cache counterpart at all: playback reads
RPM from the cache's `rpm` array directly, so it never needs a pulse train and will not
synthesise one. Selecting Tacho in playback shows an explicit "not in this file" state
rather than a flat or fabricated trace.

The sub-channel selector will be labelled accordingly in playback.

**Spectrogram and waterfall rebuild on seek.** Both accumulate `client.fftHistory`. After
a seek the history is invalid and must be recomputed — roughly 220 windows. That is a few
hundred milliseconds, so it runs debounced on scrub release rather than on every drag
frame; during the drag the two views show a stale-marked state.

## Backend defects

`/record/start_replay` stops being the UI's path but stays reachable and covered by
`backend/tests/test_replay.py`. Both defects are small and leaving known-wrong numbers in
a tested endpoint is worse than fixing them:

- `RecordingSession` builds `FrmIntegrator` from `cfg`; it will take `fs` from
  `source.rate`, as `CutDetector` and `_update_fft` already do.
- `ReplaySource.read()` drops the `min(dt, 0.1)` sleep cap so a requested speed is
  honoured for cuts of any length.

## Testing

`spectrum.ts` — Vitest against a stubbed `fetch`: throttling holds to ~3/s, a second
request while one is in flight coalesces rather than queues, and a sidecar error surfaces
without stalling the playhead. The DSP itself is not retested here; it is
`session._update_fft`'s existing scipy path.

`/dsp/spectrum` — a backend test asserting it returns the same `f` and spectra as
`_update_fft` produces for the same window, so the two paths cannot drift.

`engine.ts` — Vitest on the seek invariant that makes scrubbing trustworthy: buffer
contents after `seek(t)` must equal contents after playing straight through to `t`.
Also covers clamping at both ends, `windowSec` trimming, and that the engine issues no
network call other than the spectrum request.

Backend — extend `test_replay.py` with a decimated case (a cut long enough to force
`stride > 1`) asserting the live RPM matches the cache's, which is the assertion the
current tests miss because their fixtures are all `stride == 1`.

The existing Playwright specs in `tests/ui/` cover panel wiring.
