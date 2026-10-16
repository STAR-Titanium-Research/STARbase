"""MinIO / S3-compatible object storage client (put, head, get: the worker only writes its own prefix)."""

import os

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET: str = os.getenv("MINIO_BUCKET", "d1-files")

_MISSING_CODES = {"404", "NoSuchKey", "NotFound"}


def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.getenv("MINIO_ENDPOINT", "http://minio:9000"),
        aws_access_key_id=os.getenv("MINIO_ROOT_USER", "minioadmin"),
        aws_secret_access_key=os.getenv("MINIO_ROOT_PASSWORD", "minioadmin"),
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def put_object(
    object_key: str, data: bytes, content_type: str = "application/octet-stream"
) -> None:
    """Upload *data* as a single object."""
    _client().put_object(
        Bucket=BUCKET, Key=object_key, Body=data, ContentType=content_type
    )


def object_exists(object_key: str) -> bool:
    """True when *object_key* is in the bucket (HEAD); other S3 errors propagate."""
    try:
        _client().head_object(Bucket=BUCKET, Key=object_key)
    except ClientError as err:
        if str(err.response.get("Error", {}).get("Code")) in _MISSING_CODES:
            return False
        raise
    return True


def get_object_bytes(object_key: str) -> bytes | None:
    """The object's bytes, or None when it does not exist. For small objects only (meta.json)."""
    try:
        return _client().get_object(Bucket=BUCKET, Key=object_key)["Body"].read()
    except ClientError as err:
        if str(err.response.get("Error", {}).get("Code")) in _MISSING_CODES:
            return None
        raise
