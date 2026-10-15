#!/bin/sh
# Creates the MinIO user that Directus (the d1-surface-scan endpoint, ADR-0020) reads rendered surface scans with.
# Run by `make bootstrap-minio` inside the minio/mc image (alias "local" comes from MC_HOST_local); idempotent.
#
# The policy allows exactly two things, both on the surface-scans/ prefix of the heavy-data bucket:
#   s3:GetObject    on <bucket>/surface-scans/*
#   s3:ListBucket   on <bucket>, only for the prefix surface-scans/* (condition s3:prefix). Without it MinIO answers 403
#                   AccessDenied instead of 404 NoSuchKey for a key that is not there, which the endpoint would report as a
#                   broken store instead of "render the scan again".
# No write, no delete, no other prefix, no other bucket.
#
# Environment: BUCKET (default d1-files), READER_USER (default surface-reader), READER_PASSWORD (required; empty skips).
set -eu

BUCKET="${BUCKET:-d1-files}"
READER_USER="${READER_USER:-surface-reader}"
if [ -z "${READER_PASSWORD:-}" ]; then
    echo "MINIO_SURFACE_READER_PASSWORD is empty: surface reader not created (the surface-scan viewer will answer 503)."
    exit 0
fi

policy=/tmp/surface-reader-policy.json
cat > "$policy" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/surface-scans/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}"],
      "Condition": {"StringLike": {"s3:prefix": ["surface-scans/*"]}}
    }
  ]
}
JSON

mc admin policy create local surface-reader "$policy"
mc admin user add local "$READER_USER" "$READER_PASSWORD"
# attach fails when the policy is already attached: that is the state we want
mc admin policy attach local surface-reader --user "$READER_USER" \
    || mc admin user info local "$READER_USER" | grep -q surface-reader
echo "Surface reader ready: user ${READER_USER}, read-only on ${BUCKET}/surface-scans/"
