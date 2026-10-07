---
name: force-scaffold
description: Use when adding a new piece to the force app that spans several files. Covers a live Record panel or Plot-page panel or plot mode, a backend endpoint with its web client, a channel or sensor role, a change to a force file format (D1LC/D1RW/D1LF/.mat), or a diagnostics recipe step. Lists every file that has to change together, and the tests, so nothing is left half-wired.
argument-hint: panel | endpoint | channel | format | diag-step
---

# Force-app scaffolding

Kind requested: `$ARGUMENTS`

Read the matching reference before writing code. Each one lists the files real commits changed
together, the pattern to copy and the test that proves it:

| Kind | Reference | Model commit (see `git show <sha> --stat`) |
|---|---|---|
| `panel`: live Record panel, Plot-page panel or plot mode | [references/panel.md](references/panel.md) | 36069d5 (polar Record panel), 67070a0 (PolarPlot) |
| `endpoint`: backend route + web client | [references/endpoint.md](references/endpoint.md) | 8247288 (`POST /dsp/spectrum`) |
| `channel`: channel role, Aux/virtual channel, dyno preset | [references/channel.md](references/channel.md) | bbeba7f (virtual/Aux channels) |
| `format`: D1LC/D1RW/D1LF/`.mat` change | [references/format.md](references/format.md) | 1489c4b (D1LC v2 trailer) |
| `diag-step`: diagnostics recipe op | [references/diag-step.md](references/diag-step.md) | bb3a864 (invert/griddify/gmm) |

If the kind is missing or doesn't fit, ask which one it is. If it's none of them, use
`force-app-conventions` and the developer guide directly.

These are shallow clones, so a model commit may be missing locally. Run `git fetch --unshallow`
(or `--deepen=300`) if `git show` can't find it.

Every kind finishes the same way:
1. Unit tests on each side you touched (table in `force-app-conventions`).
2. `force-app-verify` for anything visible in the Record page or produced by a recording.
3. A user-visible change gets a line in the next `web/src/changelog.ts` entry when it's released
   (`force-app-release` skill). It doesn't need its own version bump.
4. A substantial feature gets a spec in `docs/superpowers/specs/` (`adr` skill).
