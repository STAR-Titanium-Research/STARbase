"""Enumerate NI-DAQ hardware into a chassis → modules → ports tree the UI can draw.

Two paths, same JSON shape:
  * real      — walk ``nidaqmx.system.System.local().devices`` (only where the DAQmx runtime
                exists). ``system`` is injectable so the parser is unit-testable with a fake tree.
  * simulated — expand a compact ``[{slot, product_type}]`` layout (persisted, editable via the
                add/remove-card endpoints) into the same tree. Used on dev machines w/o DAQmx.

Port ``physical`` is the exact nidaqmx channel string ("cDAQ1Mod1/ai0") that a task / NidaqSource
consumes, so an assignment maps 1:1 onto acquisition.
"""

from __future__ import annotations

from . import nidaq_catalog as cat

# Compact default simulated rig: an 8-slot cDAQ with two ±10 V AI cards + an IEPE card.
DEFAULT_SIM_LAYOUT = {
    "name": "cDAQ1",
    "product_type": "cDAQ-9178",
    "slots": 8,
    "cards": [
        {"slot": 1, "product_type": "NI 9215"},
        {"slot": 2, "product_type": "NI 9215"},
        {"slot": 3, "product_type": "NI 9234"},
    ],
}


def _ports_for(dev_name: str, entry: dict) -> list[dict]:
    """Synthesise ai0..aiN / ctr0..ctrM ports from a catalog entry's channel counts."""
    ports: list[dict] = []
    for i in range(int(entry.get("ai", 0))):
        ports.append({"id": f"ai{i}", "kind": "ai", "physical": f"{dev_name}/ai{i}"})
    for i in range(int(entry.get("ci", 0))):
        ports.append({"id": f"ctr{i}", "kind": "ci", "physical": f"{dev_name}/ctr{i}"})
    return ports


def _module(dev_name: str, product_type: str, slot: int, ports: list[dict] | None = None) -> dict:
    entry = cat.lookup(product_type)
    return {
        "name": dev_name,
        "product_type": product_type,
        "label": entry.get("label", product_type),
        "slot": int(slot),
        "connector": entry.get("connector", "terminal"),
        "note": entry.get("note", ""),
        "iepe": bool(entry.get("iepe", False)),
        "ports": ports if ports is not None else _ports_for(dev_name, entry),
    }


def enumerate_simulated(layout: dict | None = None) -> dict:
    layout = layout or DEFAULT_SIM_LAYOUT
    modules = []
    for card in sorted(layout.get("cards", []), key=lambda c: int(c["slot"])):
        slot = int(card["slot"])
        name = f"{layout['name']}Mod{slot}"
        modules.append(_module(name, card["product_type"], slot))
    chassis = {
        "name": layout.get("name", "cDAQ1"),
        "product_type": layout.get("product_type", "cDAQ-9178"),
        "slots": int(layout.get("slots", 8)),
        "modules": modules,
    }
    return {"simulated": True, "chassis": [chassis], "standalone": []}


def _ports_from_names(names, kind: str) -> list[dict]:
    return [{"id": n.split("/")[-1], "kind": kind, "physical": n} for n in names]


def _chan_names(collection) -> list[str]:
    out = []
    for ch in collection or []:
        out.append(getattr(ch, "name", str(ch)))
    return out


def enumerate_real(system, devices: list | None = None) -> dict:
    """Parse a live (or faked) nidaqmx System into the tree. Defensive: DAQmx property access can
    raise per-device, so every read is guarded and a bad device is skipped rather than fatal.
    `devices` is the already-listed `system.devices`, so a caller that has it doesn't ask twice."""
    chassis_by_name: dict[str, dict] = {}
    modules_by_chassis: dict[str, list[dict]] = {}
    standalone: list[dict] = []

    if devices is None:
        devices = list(getattr(system, "devices", []) or [])
    # First pass: identify chassis (they own module devices).
    for dev in devices:
        mods = _safe(lambda: list(dev.chassis_module_devices), [])
        if mods:
            chassis_by_name[dev.name] = {
                "name": dev.name,
                "product_type": _safe(lambda: dev.product_type, "cDAQ"),
                "slots": len(mods) or 8,
                "modules": [],
            }
            modules_by_chassis.setdefault(dev.name, [])

    # Second pass: place each non-chassis device as a module or a standalone device.
    for dev in devices:
        if dev.name in chassis_by_name:
            continue
        product_type = _safe(lambda: dev.product_type, "")
        ai = _ports_from_names(_chan_names(_safe(lambda: dev.ai_physical_chans, [])), "ai")
        ci = _ports_from_names(_chan_names(_safe(lambda: dev.ci_physical_chans, [])), "ci")
        ports = ai + ci
        chassis = _safe(lambda: dev.compact_daq_chassis_device, None)
        slot = _safe(lambda: dev.compact_daq_slot_num, 0)
        if chassis is not None and getattr(chassis, "name", None) in chassis_by_name:
            modules_by_chassis[chassis.name].append(
                _module(dev.name, product_type, slot, ports=ports)
            )
        else:
            standalone.append(_module(dev.name, product_type, slot or 0, ports=ports))

    for name, mods in modules_by_chassis.items():
        chassis_by_name[name]["modules"] = sorted(mods, key=lambda m: m["slot"])
    return {
        "simulated": False,
        "chassis": list(chassis_by_name.values()),
        "standalone": standalone,
    }


def _safe(fn, default):
    try:
        return fn()
    except Exception:
        return default


def _enumerate(sim_layout: dict | None, system) -> tuple[dict, list | None]:
    """(tree, devices): the real tree when DAQmx lists at least one device, else the simulated one.

    `devices` is None when there is no usable runtime: no System at all, or the package imports
    but the driver is missing, in which case listing devices (the first call that needs it) is
    what raises. That counts as "no runtime", the same as the package being absent."""
    sysobj = system if system is not None else _local_system()
    devices = _safe(lambda: list(sysobj.devices or []), None) if sysobj is not None else None
    tree = enumerate_real(sysobj, devices) if devices else enumerate_simulated(sim_layout)
    return tree, devices


def enumerate_devices(sim_layout: dict | None = None, system=None) -> dict:
    """Real enumeration when a DAQmx System lists a device, else simulated. Never raises for a
    missing or broken runtime: the channel config, first-run autoassign and /record/start all
    enumerate through here on machines that may have the nidaqmx package but no driver."""
    return _enumerate(sim_layout, system)[0]


def describe_devices(sim_layout: dict | None = None, system=None) -> dict:
    """enumerate_devices plus what the UI needs to decide whether NI-DAQ can be offered (#86).

    `simulated` alone conflated two things: it is True both when the DAQmx runtime is missing and
    when the runtime is installed but no device is connected — the editable simulated tree is
    shown in either case. The NI-DAQ recording source needs a real device, so:

      runtime_available  the nidaqmx package + DAQmx runtime load on this host
      hardware_present   DAQmx reports at least one device

    NI MAX simulated devices count as present: DAQmx enumerates them like physical ones and a task
    on them really runs (that is what they are for — validating a setup without the chassis).
    `nimax_simulated` flags that case so the UI can say so.
    """
    tree, devices = _enumerate(sim_layout, system)
    return {
        **tree,
        "runtime_available": devices is not None,
        "hardware_present": bool(devices),
        "nimax_simulated": bool(devices)
        and all(_safe(lambda d=d: bool(d.is_simulated), False) for d in devices),
    }


def _local_system():
    try:
        from nidaqmx.system import System

        return System.local()
    except Exception:
        return None


def max_sample_rate(channels: list[str], system=None) -> float | None:
    """The real achievable sample rate for a set of physical channel names ("cDAQ1Mod1/ai0"),
    e.g. what a live /record/start's requested sample_rate must not exceed (#46: a rate request
    the hardware can't actually deliver surfaces as a raw DAQmx acquisition-time error --
    "DAQmx_SampClk_Rate ... Maximum Value: 51.367188e3" -- rather than a clear pre-flight warning).

    Queries each involved device's own ai_max_multi_chan_rate (this already accounts for the
    device's per-channel vs. multi-channel aggregate throughput, which is why a flat per-product
    constant from nidaq_catalog wouldn't be accurate here) and returns the minimum across devices
    actually in play -- the binding constraint when channels span more than one module. None when
    there's no real DAQmx system to ask (simulated hardware, or the runtime isn't installed): a
    simulated device has no physical rate ceiling to check against.
    """
    return sample_rate_limits(channels, system=system)["max"]


def sample_rate_limits(channels: list[str], system=None) -> dict:
    """{"max": Hz | None, "min": Hz | None} for a set of physical channels — max_sample_rate's
    ceiling plus the matching floor (the highest ai_min_rate among the devices in play), for
    /record/start's pre-flight check (#84). Both None when there is no real DAQmx system to ask."""
    out: dict = {"max": None, "min": None}
    sysobj = system if system is not None else _local_system()
    if sysobj is None:
        return out
    dev_names = {ch.split("/")[0] for ch in channels if "/" in ch}
    if not dev_names:
        return out
    maxes, mins = [], []
    for dev in _safe(lambda: list(sysobj.devices or []), []):
        if dev.name in dev_names:
            rate = _safe(lambda: dev.ai_max_multi_chan_rate, None)
            if rate:
                maxes.append(float(rate))
            floor = _safe(lambda: dev.ai_min_rate, None)
            if floor:
                mins.append(float(floor))
    out["max"] = min(maxes) if maxes else None
    out["min"] = max(mins) if mins else None
    return out
