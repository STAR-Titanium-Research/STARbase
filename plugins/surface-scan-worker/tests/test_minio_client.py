"""The MinIO wrapper: missing objects are None / False, other S3 errors propagate."""

from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from app.lib import minio_client


def _err(code):
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "Op")


@pytest.fixture
def s3(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(minio_client, "_client", lambda: client)
    return client


def test_put_object_sets_the_content_type(s3):
    minio_client.put_object("surface-scans/k/thumb.png", b"png", "image/png")
    kwargs = s3.put_object.call_args.kwargs
    assert kwargs["Key"] == "surface-scans/k/thumb.png"
    assert kwargs["Body"] == b"png"
    assert kwargs["ContentType"] == "image/png"


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_missing_object(s3, code):
    s3.head_object.side_effect = _err(code)
    s3.get_object.side_effect = _err(code)
    assert minio_client.object_exists("k") is False
    assert minio_client.get_object_bytes("k") is None


def test_present_object(s3):
    s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"{}")}
    assert minio_client.object_exists("k") is True
    assert minio_client.get_object_bytes("k") == b"{}"


def test_other_errors_propagate(s3):
    s3.head_object.side_effect = _err("AccessDenied")
    s3.get_object.side_effect = _err("AccessDenied")
    with pytest.raises(ClientError):
        minio_client.object_exists("k")
    with pytest.raises(ClientError):
        minio_client.get_object_bytes("k")
