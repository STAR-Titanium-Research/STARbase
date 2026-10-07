"""The prompt dictionary only lists objects the role can read (allow-list, ADR-0009)."""

from unittest.mock import patch

from app.lib import db


def test_dictionary_is_filtered_by_select_privilege():
    with patch("app.lib.db.run_select", return_value=[]) as mock_run:
        db.fetch_dictionary_all()
    sql = mock_run.call_args.args[0]
    assert "has_table_privilege" in sql
    # to_regclass: a bare ::regclass cast would raise for non-public objects the
    # planner may evaluate the filter on before the view's own schema filter.
    assert "to_regclass" in sql
