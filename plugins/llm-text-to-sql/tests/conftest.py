"""pytest configuration — add plugin root to sys.path and set safe defaults."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Safe defaults so importing the app needs no running stack.
os.environ.setdefault("LLM_DATABASE_URL", "postgres://x:x@localhost:5432/x")
os.environ.setdefault("OLLAMA_URL", "http://ollama:11434")
# The API fails closed without a shared secret, so tests configure one and the
# default test client presents it. Tests that exercise auth pass their own header.
TEST_SECRET = "test-worker-secret"
os.environ["WORKER_WEBHOOK_SECRET"] = TEST_SECRET

from flask.testing import FlaskClient  # noqa: E402

from app.api import app  # noqa: E402


class _AuthedClient(FlaskClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.environ_base = {
            **self.environ_base,
            "HTTP_X_WORKER_SECRET": TEST_SECRET,
        }


app.test_client_class = _AuthedClient
