# Adding or changing a channel (e.g. virtual/Aux channels, bbeba7f)

A channel crosses the whole pipeline: the NI-DAQ mapping, acquisition, the raw file, finalize,
recovery, storage, the live stream, the UI and the upload. Missing one hop gives a capture that
records fine and is silently wrong later.

## Backend (`apps/force-app/backend/app/`)

| File | What lives there |
|---|---|
| `channels.py` | roles (`Fx`, `Fy`, `Fz`, `Mz`, `Tacho`, `Index`, `Aux`), presets `stationary_8` and `rotating_4`, `to_record_channels`, `to_extra_channels`, `dyno_gains`, `infer_dyno_kind` |
| `config.py` | `DYNO_CHANNELS`, `AXIS_SUM`, `DEFAULT_NIDAQ_CHANNELS` (placeholders `cDAQ1Mod{1,2,3}/ai*`), `RecordConfig.extra_channels` |
| `virtual_channels.py` | formula channels (validated by `POST /nidaq/channels/validate-formula`) |
| `sources/nidaq.py`, `sources/sim.py`, `sources/replay.py` | every source must produce the same column layout |
| `session.py`, `finalize.py` | raw columns, `.mat` `DATA`/`VariableNames`, D1LC, `summary.json` `channels` |
| `recovery.py`, `storage.py` | recovering and listing captures with extra columns |
| `main.py` | `/nidaq/channels*`, `/record/start` (widens the physical list for hardware Aux) |

## Web (`apps/force-app/web/src/`)

`nidaq/NidaqPage.vue`, `nidaq/nidaqApi.ts`, `record/types.ts`, `record/workspace.ts`,
`record/uploadCapture.ts`, plus the colour in `record/types.ts` (`CH_COLOR`/`channelColor`) if it's plotted.

## Rules

- **Append, never insert.** Extra channels go after column 10 of the v1.0 layout. Every archive
  reader depends on the first 10 (`docs/force-file-standards.md`).
- **Index is never auto-assigned** by `POST /nidaq/channels/autoassign`.
- **`rotating_4` refuses record-start** until the capture v2.0 schema ships. That spec is
  `docs/superpowers/specs/2026-07-27-force-capture-v2-schema-design.md` and is still *design only*.
  Don't quietly enable it.
- A saved config has no "kind" field. `infer_dyno_kind()` recovers it from the channels. If it
  can't, a rotating config falls through to placeholder channels with no gains, which records
  garbage without an error. Keep that path raising.
- Sim and replay data are already in newtons (gain 1). NI-DAQ volts are converted with per-channel
  `dyno_gains` (N/V = range / analog full scale).
- A config with no extra channels must stay **byte-identical** to before (D1LC v1, 10-column `.mat`).

## Tests

`test_channels.py`, `test_virtual_channels.py`, `test_extra_channels_finalize.py`, `test_nidaq*.py`,
`test_pipeline.py`, `test_captures_manage.py`, `test_recovery.py`. Then run
`force-app-verify`'s `sim_record.py --json '{"extra_channels": [...]}'` and check that the new
column appears after `Tacho` in `summary.json` `channels`. Real DAQ wiring can only be confirmed on
the rig, so say so.
