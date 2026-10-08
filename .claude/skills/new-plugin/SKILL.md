---
name: new-plugin
description: Use when adding a new compute service or worker to D1-Database — anything that processes files from MinIO, reacts to a Directus Flow webhook, or writes results back to test_sessions. Scaffolds plugins/<name>/ from plugins/plugin-template and wires it into docker-compose, .env.example, the Makefile, CI and the plugins README.
argument-hint: [plugin-name]
---

# New plugin

Lab-specific compute is a plugin, never part of the core (CONTRIBUTING golden rule 3, ADR-0007).
A plugin talks to the core only through `docs/plugin-contract.md`: webhook in, REST write-back
out, statuses from the shared vocabulary.

Plugin name: `$ARGUMENTS`. Use kebab-case. The directory, compose service and `QUEUE_NAME` all use
this name; the Python package stays `app`.

## First decide: is it really a new plugin?

- **New data, collection or algorithm** → copy `plugins/plugin-template/` (this skill).
- **Another mode of the D1F force-file pipeline** → extend `plugins/heavy-data-worker/`.
- **Interactive, synchronous previews behind the UI** → model it on `plugins/filter-service/` or
  `plugins/diag-service/`. Those forward the caller's Directus credentials and are routed by
  Caddy, not triggered by Flows.
- **Runs next to lab hardware** → it belongs in `apps/force-app/`, not `plugins/`.

`plugins/plugin-template/README.md` is the full authoring guide. Read it, then do the steps
below. They also cover what the guide leaves out.

## Steps

1. `cp -r plugins/plugin-template plugins/<name>`, then replace `app/jobs/example_job.py` with
   your job. Keep the envelope: mark `processing`, `try` the work, mark `failed` and **re-raise**
   in `except`. Import statuses from `app.lib.statuses`; never hard-code them.
2. Point `app/webhook.py` at your job function. Leave `app.before_request(check_secret)` and
   `valid_object_key` wired in.
3. Add dependencies below the `# --- job-specific ---` marker in `requirements.txt`.
4. Write unit tests in `plugins/<name>/tests/`. Mock `directus_client` and `minio_client` at
   module level, as `test_example.py` does. A test for the failure path (status → `failed`,
   exception re-raised) is not optional.
5. **docker-compose.yml**: start from the template README's §6 block, then add
   `networks: [d1net]` (the README's block lacks it, and every real service has it) and
   `QUEUE_NAME: <name>`. Keep the `service_healthy` conditions. Map a new host port to
   container port 8080.
   Host ports already taken: !`grep -oE '"\$\{[A-Z_]+:-[0-9]+\}:[0-9]+"' docker-compose.yml | tr '\n' ' '`
6. **.env.example**: document every new `${VAR}` that compose references. `tests/phase0_smoke.sh`
   fails on any undocumented one.
7. **Makefile**: add `<name>-build` / `<name>-test` targets (copy `analysis-build` /
   `analysis-test`) and add both to `.PHONY`.
8. **CI**: add a line for the image to `IMAGES` in `.github/scripts/ci-plan.mjs` (copy the
   `filter-service` one). CI's `images` job then builds it and runs `pytest` inside it.
9. **plugins/README.md**: add a row to the plugin table.
10. If it reacts to a new record, document the Directus Flow in `docs/runbooks/` (pattern:
    `docs/runbooks/heavy-data-pipeline.md` §3).

## Verify

```sh
docker build -t d1-<name> plugins/<name>/ && docker run --rm d1-<name> python -m pytest tests/ -v --tb=short
bash tests/phase0_smoke.sh        # env coverage + compose validity
```
Without Docker, run `pip install -r requirements.txt && python -m pytest tests/` from
`plugins/<name>/` instead, and say that the image build was not checked.

## Gotchas

- **Shared JSONB columns.** Several plugins write `test_sessions.summary_stats`. PATCHing a whole
  object overwrites the other plugins' keys. Read-merge-write via `directus_client.get_item`, and
  namespace your keys.
- **Keep the container port at 8080.** `WORKER_HTTP_PORT`, the `ports:` target, the compose
  `healthcheck` URL and the Dockerfile `EXPOSE`/`HEALTHCHECK` all have to agree. Change only the
  host side. Don't copy `analysis-worker`: it binds 8081 in-container while its Dockerfile
  healthcheck probes 8080, and only compose's healthcheck override hides that.
- **Statuses mirror a DB CHECK** (`20260619000013_status_vocabulary.sql`). A new status needs a
  migration (use the `db-migration` skill) *and* a change to `statuses.py` in every plugin.
- `WORKER_WEBHOOK_SECRET` unset disables webhook auth. Fine in dev, never in a deployed
  `.env`. The Flow must send the same value in `X-Worker-Secret`.
- Large outputs (plots, derived arrays) go to MinIO with a pointer in Postgres, never inline in
  JSONB (ADR-0006).
