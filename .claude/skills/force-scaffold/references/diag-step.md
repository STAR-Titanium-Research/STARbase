# Adding a diagnostics recipe step (e.g. invert/griddify/gmm_segmentation, bb3a864)

One recipe engine (`scripts/diag/`) runs in two places: the orchestrator's bake on d1-server, and
`plugins/diag-service` for interactive previews. The UI (`DiagnosticsWorkbench`) builds recipes from
a step catalogue. A step therefore needs engine, service and UI changes.

| Layer | Files |
|---|---|
| engine | `scripts/diag/ops.py` (the op), `registry.py` (registration and params), `runner.py` / `pipeline.py` if it changes execution, `spatial.py` / `interpolate.py` / `angular.py` for spatial ops |
| engine tests | `tests/scripts/diag/test_<op>.py` + `test_runner.py` |
| service | `plugins/diag-service/app/main.py` (if `/preview` or `/viewport` must expose new outputs) + `plugins/diag-service/tests/test_preview.py`, `test_viewport.py` |
| UI | `packages/force-plotting/src/RecipePanel.vue` (step editor), `diagHelp.ts` (help text), `recipeChannels.ts` (+ `.test.ts`, the channels a step yields), `DiagnosticsWorkbench.vue`, `SpatialPanel.vue` / `selection.ts` for spatial outputs |
| DB | a migration only if recipes or results gain a column (`db-migration`). The `diag_*` migrations show the pattern |

## Rules

- Ops are pure functions of their inputs and params, so the bake and the preview give identical
  results. No randomness without a fixed seed in the params (GMM!).
- Param defaults live in one place (the registry). The UI reads them, it doesn't duplicate them.
- An op that changes the channel set must update `recipeChannels.ts` too, or downstream steps offer
  the wrong channels.

## Tests and gotchas

```sh
python -m pytest tests/scripts/diag -q
cd plugins/diag-service && python -m pytest -q
npm test -w @d1/force-plotting
```
- `*_golden_exactly` tests compare byte-for-byte with fixtures frozen on the maintainer's machine.
  A different numpy, scipy or scikit-learn build can fail them with no code change (diag-service
  pins `scipy==1.14.*` and `scikit-learn==1.5.*`). Install those pins before judging a golden
  failure, and read `tests/scripts/diag/regenerate_goldens.py` before regenerating anything.
- `test_diag_requeue_trigger.py` needs a migrated Postgres at `DATABASE_URL`
  (`db-migration`'s `scratch_pg.sh`).
- diag-service builds from the repo root and copies `scripts/diag/`. Rebuild its image after engine
  changes.
