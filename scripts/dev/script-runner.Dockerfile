# Runner for tests/scripts (pytest, incl. the DB-level tests): psql + jq + curl + git + python3 with
# the packages CI's script-tests job installs. Used by scripts/dev/script_tests_docker.sh; the same
# Postgres major as CI's service.
# Bump RUNNER in script_tests_docker.sh whenever this file changes: the image is built only when that tag is missing.
FROM pgvector/pgvector:pg16
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git jq curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages -q "openpyxl>=3.1" "psycopg2-binary>=2.9" pytest requests \
    "numpy==2.2.*" "scipy==1.14.*" "scikit-learn==1.5.*" "h5py==3.12.*"
COPY script-runner-git-shim /usr/local/bin/git
RUN chmod +x /usr/local/bin/git && git config --system --add safe.directory '*'
