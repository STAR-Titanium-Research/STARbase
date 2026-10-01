# NI-DAQ page + arbitrary channel model — design

**Date:** 2026-08-02 · **App:** `apps/force-app` · **Slice:** first of the GUI-flexibility roadmap.
**Status:** implemented 2026-08-02 — `apps/force-app/web/src/nidaq/`,
`apps/force-app/backend/app/channels.py`, `nidaq_enum.py` and `nidaq_catalog.py`.

## Goal

Give the force-app the flexibility the MATLAB `ABetterFactoryPlusApp` has: bring in extra
NI-DAQ channels beyond the fixed 8 dyno + tacho, and configure them visually. A dedicated
**NI-DAQ page** shows a stylised chassis with each detected C-series module drawn to its real
connector geometry (BNC / spring-terminal / D-Sub), and the user assigns each physical input
(BNC/pin) to a **channel** with a **role**. The channel model becomes arbitrary (any number of
channels), while the app still defaults to force measurement (auto-assigns Fx/Fy/Fz + Tacho).

Detection is **simulated** on dev machines (no DAQmx runtime) and **real** on the rig — the
simulated structure mirrors the nidaqmx Python object model so the real path is a drop-in.

## nidaqmx object model we mirror

From `nidaqmx.system` Device properties: `name` ("cDAQ1Mod1"), `product_type` ("NI 9215"),
`serial_num`, `is_simulated`, `ai_physical_chans` / `ci_physical_chans` (names like
"cDAQ1Mod1/ai0"), `chassis_module_devices` (modules in a chassis), `compact_daq_chassis_device`,
`compact_daq_slot_num`. Physical channel name = `<device>/<port>` — exactly the string a task's
`add_ai_voltage_chan` / counter input needs, and what `NidaqSource` already consumes.

## Components

### Backend

- **`nidaq_catalog.py`** — static card catalog: `product_type` → `{label, connector, ai, ci,
  vmax, ks, note}`. Connector ∈ `bnc | terminal | dsub`. Seeds: NI 9215 (bnc, 4×±10 V),
  NI 9234 (bnc/IEPE, 4×±5 V), NI 9250 (bnc/IEPE, 2×), NI 9205 (terminal, 32×), **NI 9201**
  (terminal, 8×±10 V), NI 9401 (dsub, 8 digital/counter), NI 9411 (dsub, 6 diff digital).
  Generic fallback for unknown `product_type` (connector `terminal`, ai from `ai_physical_chans`).
- **`nidaq_enum.py`** — `enumerate_devices()`:
  - real: walk `nidaqmx.system.System.local().devices`, group modules under their chassis via
    `compact_daq_chassis_device` / `compact_daq_slot_num`; standalone USB DAQ = its own group.
  - simulated: return a default chassis (cDAQ-9178, 8 slots) with 9215 / 9215 / 9234 populated,
    plus the ability to add/remove cards (persisted).
  - Output JSON: `{ simulated: bool, chassis: [{ name, product_type, slots, modules: [{ name,
    product_type, slot, connector, ports: [{ id:"ai0", kind:"ai"|"ci" }] }] }], standalone: [...] }`.
  - Simulated layout persisted to `nidaq_sim.json` under the captures/config dir; add-card /
    remove-card endpoints mutate it.
- **`channels.py`** — the **channel model** (persisted `nidaq_channels.json`):
  - `Channel { name, role, physical|null, sensitivity_pc_per_n|null, gain_n_per_v|null,
    source: "hardware"|"virtual", color }`. `role ∈ Fx | Fy | Fz | Tacho | Aux`.
  - Force axes are **role-derived**: all `Fx` channels sum into Fx, etc. (replaces the fixed
    Fx1..Fz4 layout). Tacho role marks the tacho. Aux = recorded, not summed. Virtual = no
    `physical` binding yet (bindable later).
  - `autoassign(devices)` — force-first default: fill Fx,Fx,Fy,Fy,Fz,Fz,Fz,Fz across the first 8
    AI ports found, **Tacho → ai0** of the next module; leave the rest unassigned.
  - `to_record_channels()` — ordered `physical` list + parallel role/gain metadata handed to
    `RecordConfig` at record start (this slice keeps the recorder's existing column pipeline;
    variable raw columns + per-channel live streaming are the NEXT slice).
- **Endpoints** (in `main.py`): `GET /nidaq/devices`, `GET /nidaq/catalog`,
  `POST /nidaq/sim/card` (add), `DELETE /nidaq/sim/card` (remove), `GET/PUT /nidaq/channels`
  (the channel config), `POST /nidaq/channels/autoassign`. Loopback-bound like the rest.

### Frontend (`apps/force-app/web/src/nidaq/`)

- **Route** `/nidaq` + a sidebar entry ("NI-DAQ", icon `cable`/`dashboard`) in `AppShell`.
- **`NidaqPage.vue`** — loads devices + channels; header shows SIMULATED/LIVE badge + refresh.
- **`Chassis.vue` / `Module.vue`** — render the chassis with **portrait/vertical** modules
  (real C-series geometry: tall, narrow, connectors stacked). `Module` picks a connector
  sub-view by `connector`: **`BncPorts` / `TerminalPorts` / `DsubPorts`**. Assigned ports show a
  role colour chip; unassigned are dimmed. Empty slots show a **centered +** → card catalog.
- **`AssignPopover.vue`** — click a port → pick role (Fx/Fy/Fz/Tacho/**+ New aux…**/
  **+ Virtual channel…**) + sensitivity/gain. Model A (diagram-centric).
- **`CardCatalog.vue`** — gallery of catalog cards (mini connector preview + name + specs);
  picking one adds it to the target empty slot (simulated path).
- **`ChannelList.vue`** — side list of the channel model (roles, bindings), add virtual channel,
  clear/auto-assign; drives what the recorder uses.
- **`nidaqApi.ts`** — typed fetch helpers for the endpoints. Colours reuse the app's
  Fx/Fy/Fz/Tacho/Aux palette.

## Colours / roles

Fx `#f87171`, Fy `#4ade80`, Fz `#60a5fa`, Tacho `#c084fc`, Aux `#fbbf24`, Virtual `#38bdf8`.

## Out of scope (next slices)

- Variable raw-file columns + `.mat` layout from the arbitrary channel model.
- Per-sub-channel **live** streaming (new D1LF frame) so each channel is viewable during a cut.
- Flexible add/close/duplicate **panels** on Record + Plot; the 3-band force plot; light mode;
  denser recording controls. (Tracked separately; this slice is the NI-DAQ page + channel model.)

## Verification

- Backend unit tests: catalog lookup + generic fallback; simulated enumeration shape; real-path
  parsing from a faked nidaqmx device tree; `autoassign` force-first + Tacho-on-ai0; add/remove
  card persistence; `to_record_channels` ordering.
- E2E (Playwright, mock/sim): NI-DAQ page renders the chassis, connector views per card, the
  assign popover sets a role, add-card adds a module, a virtual channel appears in the list.
