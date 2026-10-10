# psql + bash + python3 for tests/phase1_schema.sh (the migration-141 block needs python3).
# Used by scripts/dev/schema_test_docker.sh; the same Postgres major as CI's service.
FROM pgvector/pgvector:pg16
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
