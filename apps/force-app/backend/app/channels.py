"""The arbitrary channel model: named channels with a role, optionally bound to a physical NI-DAQ
input. Roles drive the force maths (all ``Fx`` channels sum into Fx, etc.); ``Tacho`` marks the
speed input; ``Index`` marks a zero-count/tooth-identity pulse (opt-in only -- see the module
docstring note below); ``Aux`` is recorded but not summed. ``source="virtual"`` channels have no
physical binding yet (bindable later).

Two dyno presets:
  - DYNO_STATIONARY ("stationary_8"): today's 4-component plate, Fx1/Fx2/Fy1/Fy2/Fz1..Fz4 summed
    in pairs/quads into Fx/Fy/Fz. Bridges to the recorder's fixed
    [Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4,Tacho] layout.
  - DYNO_ROTATING ("rotating_4"): a rotating cutting-force dynamometer (e.g. Kistler RCD 9170B /
    9123C) -- four SINGLE components Fx, Fy, Fz, Mz, no paired corners to sum. This preset can be
    authored and persisted, but `to_record_channels` refuses to start a recording with it: the
    fixed 9-column layout has no slot for a lone Fx or for Mz. That needs the v2 variable-column
    recorder (see docs/superpowers/specs/2026-07-27-force-capture-v2-schema-design.md), which is
    a separate, larger piece of work -- see
    docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md #5.

``Index`` is never auto-assigned: it needs >=4 kHz sampling against the standard force channels'
~1 kHz anti-aliasing filter (Kistler 9123C manual, chapter 5.8), so binding it is an explicit,
opt-in user action, not something autoassign should guess at.
"""

from __future__ import annotations

from . import virtual_channels
from .config import DEFAULT_NIDAQ_CHANNELS, DYNO_CHANNELS, TACHO_CHANNEL, ExtraChannel

ROLES = ["Fx", "Fy", "Fz", "Mz", "Tacho", "Index", "Aux"]
ROLE_COLOR = {
    "Fx": "#f87171",
    "Fy": "#4ade80",
    "Fz": "#60a5fa",
    "Mz": "#f472b6",
    "Tacho": "#c084fc",
    "Index": "#facc15",
    "Aux": "#fbbf24",
    "Virtual": "#38bdf8",
}

DYNO_STATIONARY = "stationary_8"
DYNO_ROTATING = "rotating_4"

# Force-first default: the first 8 analog inputs become these named channels, in this order.
FORCE_ORDER = list(DYNO_CHANNELS)  # Fx1 Fx2 Fy1 Fy2 Fz1 Fz2 Fz3 Fz4
_ROLE_OF = {n: n[:2] for n in FORCE_ORDER}  # "Fx1" -> "Fx"

# Rotating dyno: four single components, role == name.
ROTATING_ORDER = ["Fx", "Fy", "Fz", "Mz"]


def make_channel(
    name: str,
    role: str,
    physical: str | None = None,
    sensitivity: float | None = None,
    gain: float | None = None,
    source: str = "hardware",
    formula: str | None = None,
) -> dict:
    return {
        "name": name,
        "role": role,
        "physical": physical,
        "sensitivity_pc_per_n": sensitivity,
        "gain_n_per_v": gain,
        # Mz's gain is N*m/V, a different unit from every other channel's N/V -- kept in its own
        # field rather than overloading gain_n_per_v, which would silently mix units.
        "gain_nm_per_v": None,
        "source": source,
        "formula": formula,
        "color": ROLE_COLOR.get("Virtual" if source == "virtual" else role, "#94a3b8"),
    }


def _ai_ports(devices: dict) -> list[str]:
    """All analog-input physical channel strings, chassis order then slot order."""
    out: list[str] = []
    for ch in devices.get("chassis", []):
        for mod in ch.get("modules", []):
            for p in mod.get("ports", []):
                if p.get("kind") == "ai":
                    out.append(p["physical"])
    for mod in devices.get("standalone", []):
        for p in mod.get("ports", []):
            if p.get("kind") == "ai":
                out.append(p["physical"])
    return out


def autoassign(devices: dict, kind: str = DYNO_STATIONARY) -> list[dict]:
    """Force-first: fill the dyno's channels across the first AI ports, then Tacho on the next
    one. Remaining ports left unassigned.

    kind=DYNO_STATIONARY (default): Fx1..Fz4 across the first 8 AI (ai0 of the next module for
    Tacho when the force channels take whole 4-ch cards) -- unchanged from before this function
    took a `kind` argument.
    kind=DYNO_ROTATING: Fx, Fy, Fz, Mz across the first 4 AI, then Tacho on the 5th. No paired
    corners -- a rotating dyno has one sensor per component.
    """
    ai = _ai_ports(devices)
    if kind == DYNO_ROTATING:
        channels: list[dict] = []
        for i, name in enumerate(ROTATING_ORDER):
            phys = ai[i] if i < len(ai) else None
            channels.append(make_channel(name, name, physical=phys))
        tacho_phys = ai[len(ROTATING_ORDER)] if len(ai) > len(ROTATING_ORDER) else None
        channels.append(make_channel(TACHO_CHANNEL, "Tacho", physical=tacho_phys))
        return channels

    channels = []
    for i, name in enumerate(FORCE_ORDER):
        phys = ai[i] if i < len(ai) else None
        channels.append(make_channel(name, _ROLE_OF[name], physical=phys))
    tacho_phys = ai[8] if len(ai) > 8 else None  # ai0 of the next module
    channels.append(make_channel(TACHO_CHANNEL, "Tacho", physical=tacho_phys))
    return channels


def infer_dyno_kind(channels: list[dict]) -> str:
    """Detect which preset a saved channel list belongs to. The persisted config
    (NIDAQ_CHANNELS_PATH) has no separate `kind` field -- PUT /nidaq/channels accepts a bare
    channel list -- so `record_start` has to recover it from the channels themselves before it
    can pass the right `kind` to `to_record_channels`/`dyno_gains`. A rotating-dyno config is the
    only one with an "Mz" channel (role or name), so that alone is decisive; everything else
    (including an empty or malformed list) is treated as the stationary default, matching every
    function in this module's own default.
    """
    for c in channels:
        if c.get("name") == "Mz" or c.get("role") == "Mz":
            return DYNO_ROTATING
    return DYNO_STATIONARY


def to_record_channels(channels: list[dict], kind: str = DYNO_STATIONARY) -> list[str]:
    """Ordered physical list for the recorder's fixed [Fx1..Fz4, Tacho] layout. Unbound slots keep
    the placeholder default so a partial config still starts.

    Raises ValueError for kind=DYNO_ROTATING: the fixed 9-column layout has no slot for a single
    Fx or for Mz. A rotating-dyno config can be saved and inspected; starting a recording with one
    needs the v2 variable-column recorder, which does not exist yet.
    """
    if kind == DYNO_ROTATING:
        raise ValueError(
            "rotating-dyno configs need the v2 variable-column recorder; "
            "config is saved but recording is not yet supported"
        )
    by_name = {c["name"]: c for c in channels}
    order = FORCE_ORDER + [TACHO_CHANNEL]
    out: list[str] = []
    for i, name in enumerate(order):
        c = by_name.get(name)
        phys = c.get("physical") if c else None
        out.append(phys or DEFAULT_NIDAQ_CHANNELS[i])
    return out


_CORE_NAMES = set(FORCE_ORDER) | {TACHO_CHANNEL}


def to_extra_channels(channels: list[dict]) -> list[ExtraChannel]:
    """Everything beyond the fixed [Fx1..Fz4, Tacho] layout — real Aux inputs (bound to a physical
    port, genuinely acquired) and virtual channels (a formula, computed from other channels, never
    acquired). Order is preserved from the stored config, which is also acquisition/evaluation
    order: a channel is skipped, not failed, if it's missing what it needs (no physical for
    hardware, no formula for virtual) — main.py's validation is what should have caught that
    earlier, at save time, when there's a UI to show the operator why."""
    out: list[ExtraChannel] = []
    for c in channels:
        name = c.get("name")
        if not name or name in _CORE_NAMES:
            continue
        source = c.get("source")
        if source == "hardware" and c.get("physical"):
            out.append(ExtraChannel(name=name, source="hardware", physical=c["physical"]))
        elif source == "virtual" and c.get("formula"):
            out.append(ExtraChannel(name=name, source="virtual", formula=c["formula"]))
    return out


def validate_virtual_formulas(channels: list[dict]) -> None:
    """Raise virtual_channels.FormulaError — with the offending channel's NAME in the message, so
    the equation-builder UI can show it directly — if any virtual channel's formula is malformed
    or references something it may not: a channel that doesn't exist in this list at all, or
    another virtual channel (formulas are flat by design; see virtual_channels.py for why).
    Called from PUT /nidaq/channels so a bad formula is caught when it's saved, with a UI right
    there to explain why, rather than silently at the next acquisition chunk that hits it.
    """
    known = set(_CORE_NAMES) | {"Fx", "Fy", "Fz"}
    for c in channels:
        if c.get("source") == "hardware" and c.get("name"):
            known.add(c["name"])
    for c in channels:
        if c.get("source") != "virtual":
            continue
        name = c.get("name") or "(unnamed)"
        try:
            refs = virtual_channels.referenced_channels(c.get("formula") or "")
        except virtual_channels.FormulaError as e:
            raise virtual_channels.FormulaError(f"'{name}': {e}") from e
        unknown = refs - known
        if unknown:
            raise virtual_channels.FormulaError(
                f"'{name}' references unknown channel(s): {', '.join(sorted(unknown))}"
            )


def dyno_gains(channels: list[dict], kind: str = DYNO_STATIONARY) -> list[float]:
    """Per-channel gains for the dyno's channels, if the config supplies them for ALL of them
    (else empty -> the recorder derives gains from the amp ranges as before).

    kind=DYNO_STATIONARY (default, unchanged): N/V gains for the 8 dyno channels via
    `gain_n_per_v`.
    kind=DYNO_ROTATING: N/V for Fx/Fy/Fz, N*m/V for Mz via the separate `gain_nm_per_v` field --
    the two units are never mixed into one list entry's meaning.
    """
    by_name = {c["name"]: c for c in channels}
    if kind == DYNO_ROTATING:
        gains: list[float | None] = []
        for name in ROTATING_ORDER:
            c = by_name.get(name, {})
            gains.append(c.get("gain_nm_per_v") if name == "Mz" else c.get("gain_n_per_v"))
        return [float(g) for g in gains] if all(g is not None for g in gains) else []

    gains = [by_name.get(n, {}).get("gain_n_per_v") for n in FORCE_ORDER]
    return [float(g) for g in gains] if all(g is not None for g in gains) else []
