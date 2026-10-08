# Contributing to D1-Database

This is a long, multi-phase, primarily-Claude-authored project with maintainer
review. These conventions keep each session **resumable cold** and the core
**clean and swappable**. Read [`plan.md`](./plan.md) and
[`docs/adr/`](./docs/adr/) before making changes.

## Golden rules (from the ADRs)

1. **The schema is the contract.** Change it only through versioned SQL
   migrations in [`db/migrations/`](./db/migrations/). Never via the Directus UI
   or manual `psql` edits. Descriptive names, units in column names, FK
   constraints, and a `COMMENT` on every table/column are mandatory.
2. **Keep the core swappable.** No depended-on business logic in Directus config
   (ADR-0002). Constraints, audit, concurrency, and views are native Postgres.
3. **Project-specific compute is a plugin**, never part of the core
   ([`plugins/`](./plugins/)), talking to the core only through the documented contract.
4. **Everything is infrastructure-as-code.** A change isn't done until
   `docker compose up` from clean reproduces it.

## Workflow

- **Branches:** work on a feature branch off `main`; open a PR. Don't commit
  directly to `main`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:`.
  Scope by area where useful, e.g. `feat(db): add physical_samples table`.
- **ADRs:** any significant or hard-to-reverse decision gets an ADR
  ([`docs/adr/`](./docs/adr/)) in the same PR.
- **Feature designs:** a substantial feature gets a design spec in
  [`docs/superpowers/specs/`](./docs/superpowers/specs/); update its Status line
  when it ships. Implementation plans are deleted once their feature has
  shipped — see [`docs/superpowers/README.md`](./docs/superpowers/README.md).
- **Phases:** keep changes within the current phase's scope (see `plan.md`);
  update the status tracker when a phase completes.
- **CI and releases:** a PR merges once the **CI passed** check is green. Merging a
  force-app version bump releases it to the rigs. See [`docs/ci-cd.md`](./docs/ci-cd.md).

## Tests — write and run them as you go

Every change ships with a test, and tests are **run before committing** (not
left for CI to discover):

- **Schema/migrations:** migrations must apply up *and* down cleanly; audit
  triggers and constraints have tests (Phase 1+). CI rolls back every migration and
  fails on anything left behind (`scripts/ci/migration_roundtrip.sh`).
- **New lab-data collection:** Lab Members only see records they are involved in
  ([ADR-0011](./docs/adr/0011-row-level-visibility.md)). Add the collection to
  `scripts/access_rules.json` (`rules`, not `unfiltered`), run
  `python3 scripts/gen_access_rules.py --write` and add a migration that applies the new rows
  (copy `20261007000141_lab_member_row_visibility.sql`). Reference data goes in `unfiltered`.
- **Plugins/services:** unit tests beside the code; integration tests in
  [`tests/`](./tests/).
- **Foundation:** `bash tests/phase0_smoke.sh` validates repo structure, env
  template, and that `docker-compose.yml` is valid.

## Local tooling

```sh
make help          # list targets
make setup         # install pre-commit hooks (needs python + pre-commit)
make test          # run the current smoke/integration tests
make compose-check # validate docker-compose.yml (dummy secrets; no .env needed)
```

`make` is optional (Linux/WSL/CI); on Windows you can run the underlying
commands directly — see the [`Makefile`](./Makefile). `pre-commit` runs
`ruff`/`black` (Python), `sqlfluff` (SQL), `hadolint` (Dockerfiles), and basic
hygiene hooks; CI enforces the same set.

## Claude Code skills

[`.claude/skills/`](./.claude/skills/) holds project skills that encode the conventions
above. Claude Code loads them on its own when a task matches, or you can type
`/<name>`. Skills marked *manual* only run when you type them.

| Skill | Use it for |
|---|---|
| `db-migration` | Writing a dbmate migration and proving up → down → up (works without Docker via a local Postgres 16) |
| `migration-review` | Reviewing a branch's migrations against the schema rules, in a separate subagent |
| `new-plugin` | Scaffolding a plugin from `plugins/plugin-template` and wiring compose, `.env.example`, Makefile and CI |
| `adr` | Writing an ADR or a design spec and updating its index |
| `ci-local` | Running the CI checks the changed files touch, before committing |
| `force-app-conventions` | Background knowledge Claude loads when touching force-app files: invariants, architecture, formats |
| `directus-ui-conventions` | Background knowledge Claude loads when touching the Directus front end (Explorer pages, Home, `@d1/ui`): invariants and checks |
| `force-scaffold` | Adding a panel, endpoint, channel, format change or diagnostics step across every file it needs |
| `force-app-verify` | Running the force app hardware-free (sim backend + real UI in headless Chromium) to prove a change works |
| `force-debug-capture` | Investigating a bad recording from a bug report, capture folder or log, ending in a report |
| `triage-bug-reports` | Triaging the open in-app bug reports into a P0–P3 batch plan and fixing them |
| `force-app-release` | *Manual.* Bump, changelog, local preflight and the release PR; merging it ships the release ([CI and releases](docs/ci-cd.md)) |
| `careful` | *Manual.* Hook that blocks destructive commands (DB drops, volume/MinIO deletes, force-push, release tags) for the session |
| `freeze` | *Manual.* Hook that limits edits to the directories you name, for the session |

[`.claude/agents/force-app-reviewer.md`](./.claude/agents/force-app-reviewer.md) is a read-only
review subagent with `force-app-conventions` preloaded. It keeps shared notes in
`.claude/agent-memory/force-app-reviewer/`. Two implementation profiles run plan streams in their
own worktrees: [`force-plotting-implementer`](./.claude/agents/force-plotting-implementer.md)
(`packages/force-plotting`) and [`directus-ui-implementer`](./.claude/agents/directus-ui-implementer.md)
(the Directus front end, with `directus-ui-conventions` preloaded), and
[`directus-ui-reviewer`](./.claude/agents/directus-ui-reviewer.md) is its read-only reviewer. [`.claude/settings.json`](./.claude/settings.json)
logs each skill use to the gitignored `.claude/skill-usage.log`
(`cut -f2 .claude/skill-usage.log | sort | uniq -c`), so unused skills can be pruned. The rest of
`.claude/` (local settings, memory, plans) stays gitignored, and so does any skill's
per-machine `config.json`.

## Security

Never commit secrets or real data. Large experimental files belong in MinIO,
never git. See [`SECURITY.md`](./SECURITY.md).
