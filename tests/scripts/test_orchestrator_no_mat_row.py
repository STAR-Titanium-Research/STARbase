"""#190: a Force App cut over the recorder's .mat size limit is saved as a finished
machining_force_analysis row with directus_files_id NULL (status 'done', series + live cache set).
A dashboard Bake / reprocess can still flip it to 'pending'. The daemon must then put it back to
'done' with an explanatory error_message, never mark it 'error' or clear its outputs."""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

pytest.importorskip("psycopg2")
pytest.importorskip("requests")

import force_orchestrator as fo  # noqa: E402


def _no_mat_row():
    return {
        "id": "r1",
        "archive_path": None,
        "fingerprint": None,
        "live_render_points": 5000,
    }


def test_process_file_without_a_linked_mat_is_not_an_error(tmp_path):
    with (
        patch.dict(os.environ, {"FORCE_WORKDIR": str(tmp_path)}),
        patch.object(fo, "run_matlab") as matlab,
    ):
        res = fo.process_file(_no_mat_row(), "matlab", 5, {})
    assert res["status"] == "no_mat"
    assert "no archive .mat linked" in res["message"]
    assert "baking or reprocessing needs an archive .mat" in res["message"]
    matlab.assert_not_called()


def _ingest_sql(res):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    fo.ingest(conn, _no_mat_row(), res, {}, "R2024b")
    assert cur.execute.call_count == 1
    sql, params = cur.execute.call_args[0]
    return conn, " ".join(sql.split()), params


def test_ingest_restores_done_and_leaves_outputs_alone():
    res = {"id": "r1", "status": "no_mat", "message": fo.NO_MAT_MESSAGE, "summary": {}}
    conn, sql, params = _ingest_sql(res)
    assert "status='done'" in sql
    assert "status='error'" not in sql
    # outputs, version stamp and the dense-render request stay as they were
    for col in (
        "matlab_version",
        "live_render_points",
        "series",
        "fft",
        "live_cache_file",
        "frm_fx",
        "processed_at",
    ):
        assert col not in sql
    assert params == [fo.NO_MAT_MESSAGE, "r1"]
    conn.commit.assert_called_once()


def test_real_errors_still_mark_error():
    res = {"id": "r1", "status": "error", "message": "matlab exit 1", "summary": {}}
    _, sql, _ = _ingest_sql(res)
    assert "status='error'" in sql
