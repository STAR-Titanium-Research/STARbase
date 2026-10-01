"""Recording configuration + the fixed dynamometer channel layout.

The channel layout intentionally matches the NI-DAQ output the MATLAB app captures (8 Kistler
charge sub-channels + a tacho), so the summing / gain / FRM / writer pipeline built here is the
exact code slice 2b reuses with a real `nidaqmx` source — only the source swaps.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# 9 signal channels (Time is carried separately as the raw file's column 0).
DYNO_CHANNELS: list[str] = ["Fx1", "Fx2", "Fy1", "Fy2", "Fz1", "Fz2", "Fz3", "Fz4"]
TACHO_CHANNEL = "Tacho"
SIGNAL_CHANNELS: list[str] = DYNO_CHANNELS + [TACHO_CHANNEL]

# Default NI-DAQ physical channel mapping for SIGNAL_CHANNELS (2b). Mirrors the MATLAB app's layout
# — the 8 Kistler charge channels across the first two modules + the tacho on a third module's ai0.
# These are PLACEHOLDERS; the operator sets the real device/channel strings for the rig.
DEFAULT_NIDAQ_CHANNELS: list[str] = [
    "cDAQ1Mod1/ai0",
    "cDAQ1Mod1/ai1",
    "cDAQ1Mod1/ai2",
    "cDAQ1Mod1/ai3",
    "cDAQ1Mod2/ai0",
    "cDAQ1Mod2/ai1",
    "cDAQ1Mod2/ai2",
    "cDAQ1Mod2/ai3",
    "cDAQ1Mod3/ai0",
]

# Summed-axis definitions (Fx = Fx1+Fx2, Fy = Fy1+Fy2, Fz = Fz1+Fz2+Fz3+Fz4) — the layout the
# .mat v1.0 format and process_force.m assume.
AXIS_SUM: dict[str, list[str]] = {
    "Fx": ["Fx1", "Fx2"],
    "Fy": ["Fy1", "Fy2"],
    "Fz": ["Fz1", "Fz2", "Fz3", "Fz4"],
}


class ExtraChannel(BaseModel):
    """A named channel beyond the fixed [Fx1..Fz4, Tacho] layout — either a real NI-DAQ input
    ("hardware", genuinely acquired, widening raw.d1raw by one column) or a computed combination
    of other channels ("virtual", never acquired — evaluated from whatever else is already
    available and appended only to the derived outputs: capture.mat and the live D1LF stream).
    Deliberately additive: SIGNAL_CHANNELS/AXIS_SUM/the base 10-column layout are untouched, so
    every existing consumer of those (process_force.m, capture.mat readers, .d1raw itself) keeps
    working unchanged whether or not any extra channels are configured.
    """

    name: str
    source: Literal["hardware", "virtual"]
    physical: str | None = None  # required for source="hardware" — the NI-DAQ physical channel
    formula: str | None = None  # required for source="virtual" — see app/virtual_channels.py


class RecordConfig(BaseModel):
    """Parameters for a (simulated, in 2a) recording run."""

    sample_name: str = Field(default="SIM-CUT", description="Sample/operation label")
    rpm: float = Field(default=1200.0, gt=0, description="Spindle speed (RPM)")
    feed: float = Field(default=0.05, gt=0, description="Feed (mm/rev)")
    diam: float = Field(default=80.0, gt=0, description="Outer diameter (mm)")
    inner_diam: float = Field(default=0.0, ge=0, description="Inner diameter (mm)")
    sample_rate: float = Field(default=25_000.0, gt=0, description="Acquisition rate (Hz)")
    duration_sec: float = Field(default=8.0, gt=0, le=600, description="Run length (s)")
    ppr: int = Field(default=1, ge=1, description="Tacho pulses per revolution")
    axis: str = Field(default="Fz", description="Axis driving the live FRM colour")

    # Nominal steady-cut force means (N) per axis — shape the synthetic cut. 2b replaces the sim.
    mean_fx: float = 40.0
    mean_fy: float = 60.0
    mean_fz: float = 120.0
    noise: float = 6.0  # gaussian noise std (N) on the summed axes

    # Free-form metadata compiled in the UI (sample/insert/tool/etc.), stamped into the .mat +
    # summary. Directus write-back of a run row is a later slice (2d); persisted locally for now.
    extra_metadata: dict[str, Any] = Field(default_factory=dict)

    # Acquisition source (2b): "sim" (default), or "nidaq" for real NI-DAQ hardware.
    source: str = "sim"
    # NI-DAQ physical channel strings mapped 1:1 onto SIGNAL_CHANNELS (source="nidaq").
    nidaq_channels: list[str] = Field(default_factory=lambda: list(DEFAULT_NIDAQ_CHANNELS))
    # Channels beyond the fixed 9 — real Aux inputs and/or virtual (computed) channels. Empty by
    # default: a config with none of these behaves byte-identically to before this field existed.
    extra_channels: list[ExtraChannel] = Field(default_factory=list)

    # Per-channel volts→N gain for the 8 dyno channels (source="nidaq"): N/V = range / analog_fs.
    # Auto-populated from the amp's (auto-ranged) per-channel ranges at record start. Empty => the
    # scalar `gain` in finalize is used instead (sim/replay data is already in N, so gain 1).
    dyno_gains: list[float] = Field(default_factory=list)
    # Amp analog-output full scale (±V) — used to detect per-channel clipping (railing) for the
    # converging between-cuts auto-range, and to record each cut's per-channel range with its data.
    analog_fullscale_v: float = 10.0

    # Optional linear drift compensation applied to the .mat + live_cache outputs (like the MATLAB
    # app). The raw .d1raw is ALWAYS saved un-compensated (source of truth).
    drift_comp: bool = False
    # Live FRM: begin the spiral at the detected cut start (so air-cut revolutions don't offset the
    # geometry). Cut start is detected causally on the live stream; the SAVED cut window is detected
    # on the full signal in finalize.
    frm_from_cut: bool = True
    # Absolute cut-detect force threshold (N) on |Fz|; 0 = adaptive (baseline mean + margin).
    cut_detect_force: float = 0.0
