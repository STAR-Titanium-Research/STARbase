# D1-Database — common commands.
# `make` is optional (Linux/WSL/CI). On Windows you can run the underlying
# commands directly; each recipe is a one-liner you can copy.
.DEFAULT_GOAL := help
SHELL         := /bin/bash

# Load .env (if present) so DATABASE_URL, POSTGRES_*, MINIO_* match the running stack instead of
# whatever happens to be in the caller's shell, then export everything to recipes. Values are
# parsed as make syntax: keep `$`, `#`, spaces and quotes out of .env (hex secrets are fine).
-include .env
export

# Migration tooling — dbmate via Docker (no local install required).
DBMATE_IMAGE  := ghcr.io/amacneil/dbmate:2
POSTGRES_HOST ?= localhost
POSTGRES_PORT ?= 5432
POSTGRES_USER ?= d1
POSTGRES_DB   ?= d1_database
# DATABASE_URL comes from .env (or the environment); this is only a fallback.
DATABASE_URL  ?= postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@$(POSTGRES_HOST):$(POSTGRES_PORT)/$(POSTGRES_DB)?sslmode=disable
# Database name taken from DATABASE_URL (what reset-db will actually drop), not POSTGRES_DB.
DB_NAME       := $(notdir $(firstword $(subst ?, ,$(DATABASE_URL))))
# dbmate runs in a container, where `localhost` is the container itself, not the host. So it joins
# the compose network and reaches Postgres as `postgres:5432` (a localhost/127.0.0.1 DSN host on
# POSTGRES_PORT is rewritten; any other host is used as given). `make up` creates the network.
# Override DBMATE_DATABASE_URL (or COMPOSE_NETWORK if your compose project is not named
# d1-database) for an unusual setup.
COMPOSE_NETWORK ?= d1-database_d1net
DBMATE_DATABASE_URL ?= $(subst @127.0.0.1:$(POSTGRES_PORT)/,@postgres:5432/,$(subst @localhost:$(POSTGRES_PORT)/,@postgres:5432/,$(DATABASE_URL)))
DBMATE_RUN    := docker run --rm --network $(COMPOSE_NETWORK) -e DATABASE_URL="$(DBMATE_DATABASE_URL)" \
		-v "$(CURDIR)/db:/db" $(DBMATE_IMAGE)
# prune-backups keeps this many of the newest backups, regardless of age.
KEEP          ?= 7

.PHONY: help setup test smoke schema-test traceability-test ai-test compose-check lint up down logs \
        migrate migrate-down migrate-status seed reset-db \
        bootstrap-minio backup restore prune-backups \
        worker-build worker-test worker-logs phase4-test \
        analysis-build analysis-test llm-build llm-test llm-eval \
        migrate-legacy migrate-legacy-dry index-archive index-archive-dry

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install pre-commit hooks (needs python + pre-commit)
	pre-commit install
	@echo "Hooks installed. Copy .env.example to .env and edit secrets."

test: smoke ## Run the full local test suite (foundation + schema if DB is up)

smoke: ## Validate the repository foundation (Phase 0 checks)
	bash tests/phase0_smoke.sh

schema-test: ## Run Phase 1 schema tests (requires DATABASE_URL or running stack)
	DATABASE_URL="$(DATABASE_URL)" bash tests/phase1_schema.sh

traceability-test: ## Run Phase 7 traceability tests (requires DATABASE_URL or running stack)
	DATABASE_URL="$(DATABASE_URL)" bash tests/phase7_traceability.sh

ai-test: ## Run Phase 6 AI-readiness tests (requires DATABASE_URL; superuser, to create roles)
	DATABASE_URL="$(DATABASE_URL)" bash tests/phase6_text_to_sql.sh

# Required secrets use ${VAR:?} in compose, so a plain `docker compose config` fails on a fresh
# clone with no .env. Validate against a throwaway env file of dummy values instead (never .env).
COMPOSE_REQUIRED_VARS := POSTGRES_PASSWORD MINIO_ROOT_PASSWORD DIRECTUS_KEY DIRECTUS_SECRET \
                         DIRECTUS_ADMIN_PASSWORD WORKER_WEBHOOK_SECRET REDIS_PASSWORD

compose-check: ## Validate docker-compose.yml is well-formed (works without a .env)
	@tmp=$$(mktemp) && trap 'rm -f "$$tmp"' EXIT && \
		for v in $(COMPOSE_REQUIRED_VARS); do echo "$$v=compose-check-dummy" >> "$$tmp"; done && \
		docker compose --env-file "$$tmp" config -q && echo "docker-compose.yml OK"

lint: ## Run all pre-commit hooks across the repo
	pre-commit run --all-files

up: ## Bring up the Docker stack
	docker compose up -d

down: ## Stop the Docker stack
	docker compose down

logs: ## Tail stack logs
	docker compose logs -f

migrate: ## Apply all pending migrations (requires DATABASE_URL and the stack's Postgres running)
	$(DBMATE_RUN) --no-dump-schema up

migrate-down: ## Roll back the latest migration (requires DATABASE_URL)
	$(DBMATE_RUN) --no-dump-schema down

migrate-status: ## Show migration status (requires DATABASE_URL)
	$(DBMATE_RUN) status

seed: ## Load reference seed data (requires DATABASE_URL and psql in PATH)
	psql "$(DATABASE_URL)" -f db/seeds/001_reference_data.sql

bootstrap-minio: ## Create MinIO buckets after first `make up` (idempotent)
	docker run --rm \
		--network $(COMPOSE_NETWORK) \
		-e MC_HOST_local="http://$(MINIO_ROOT_USER):$(MINIO_ROOT_PASSWORD)@minio:9000" \
		minio/mc:latest \
		sh -c "mc mb --ignore-existing local/d1-files \
			&& mc mb --ignore-existing local/d1-backups \
			&& echo 'Buckets ready: d1-files, d1-backups'"

backup: ## Dump PostgreSQL and upload to MinIO (stack must be running)
	bash infra/backup/backup.sh

restore: ## Restore from MinIO backup — set BACKUP_FILE=d1_<timestamp>.sql.gz
	bash infra/backup/restore.sh

prune-backups: ## Keep only the newest KEEP (default 7) local backups, however old
	@case "$(KEEP)" in ''|*[!0-9]*) echo "ERROR: KEEP must be a non-negative integer"; exit 1;; esac
	@for prefix in d1 d1globals; do \
		ls -1 ./backups/$${prefix}_*.sql.gz 2>/dev/null | sort -r | tail -n +$$(( $(KEEP) + 1 )) \
			| while read -r f; do echo "removing $$f"; rm -f -- "$$f"; done; \
	done

worker-build: ## Build the heavy-data worker Docker image
	docker build -t d1-heavy-data-worker plugins/heavy-data-worker/

worker-test: worker-build ## Run heavy-data worker unit tests inside Docker
	docker run --rm d1-heavy-data-worker \
		python -m pytest tests/ -v --tb=short

worker-logs: ## Tail heavy-data worker container logs
	docker compose logs -f heavy-data-worker

phase4-test: ## Phase 4 integration test (requires running stack, MACHINE_TOKEN and WORKER_WEBHOOK_SECRET)
	bash tests/phase4_heavy_data.sh

analysis-build: ## Build the FFT analysis worker Docker image
	docker build -t d1-analysis-worker plugins/analysis-worker/

analysis-test: analysis-build ## Run FFT analysis worker unit tests inside Docker
	docker run --rm d1-analysis-worker \
		python -m pytest tests/ -v --tb=short

llm-build: ## Build the text-to-SQL plugin Docker image
	docker build -t d1-llm-text-to-sql plugins/llm-text-to-sql/

llm-test: llm-build ## Run text-to-SQL guard/eval unit tests inside Docker
	docker run --rm d1-llm-text-to-sql \
		python -m pytest tests/ -v --tb=short

llm-eval: ## Validate the NL->SQL gold set against the guard (offline; no LLM needed)
	docker run --rm d1-llm-text-to-sql python eval/run_eval.py

migrate-legacy: ## Run Phase 8 legacy data migration (requires DATABASE_URL and XLSX)
	@test -n "$(XLSX)" || (echo "ERROR: set XLSX=/path/to/Sample_Data.xlsx" && exit 1)
	pip install -q -r scripts/requirements.txt
	DATABASE_URL="$(DATABASE_URL)" python3 scripts/migrate_legacy.py --xlsx "$(XLSX)"

migrate-legacy-dry: ## Dry-run the legacy migration (no DB required)
	@test -n "$(XLSX)" || (echo "ERROR: set XLSX=/path/to/Sample_Data.xlsx" && exit 1)
	pip install -q -r scripts/requirements.txt
	python3 scripts/migrate_legacy.py --xlsx "$(XLSX)" --dry-run

index-archive: ## Index the SMB archive into the Directus File Library (idempotent; good as a nightly cron)
	docker compose --profile archive run --rm archive-indexer

index-archive-dry: ## Dry-run the archive indexer (counts only, no DB writes)
	docker compose --profile archive run --rm archive-indexer \
		sh -c "pip install -q psycopg2-binary && python /scripts/index_archive.py --dry-run"

reset-db: ## Drop all tables and re-apply migrations + seed (DESTRUCTIVE — dev only). Asks you to type the DB name; CONFIRM=<name> skips the prompt.
	@echo "WARNING: this DROPS the database '$(DB_NAME)' and every table in it."
	@if [ "$(CONFIRM)" = "$(DB_NAME)" ]; then :; else \
		read -r -p "Type the database name ($(DB_NAME)) to confirm: " ans; \
		[ "$$ans" = "$(DB_NAME)" ] || { echo "Aborted."; exit 1; }; \
	fi
	$(DBMATE_RUN) --no-dump-schema drop || true
	$(DBMATE_RUN) --no-dump-schema up
	$(MAKE) seed
