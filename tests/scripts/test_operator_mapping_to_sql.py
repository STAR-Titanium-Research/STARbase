import importlib.util
from pathlib import Path

import pytest
from openpyxl import Workbook

SPEC = importlib.util.spec_from_file_location(
    "opmap",
    Path(__file__).resolve().parents[2] / "scripts" / "operator_mapping_to_sql.py",
)
opmap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(opmap)


def sheet(tmp_path, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "Operators"
    ws.append(
        [
            "Operator id",
            "Name as recorded",
            "Operations",
            "Active years",
            "Action",
            "Person (if MAP)",
            "New person name (if NEW)",
            "Researcher? (if NEW)",
            "Notes",
            "Why pre-filled",
            "Other spellings",
            "Already linked",
            "Additional people (comma-separated, if MAP/NEW)",
        ]
    )
    for r in rows:
        ws.append(r)
    ws.append([])
    ws.append(
        [None, "Rows to decide", "=COUNTA(B2:B3)"]
    )  # summary block must be ignored
    p = tmp_path / "m.xlsx"
    wb.save(p)
    return p


def test_map_new_ignore_and_blank(tmp_path):
    sql = opmap.convert(
        sheet(
            tmp_path,
            [
                [121, "Nick", 1151, "2020", "MAP", "Nick Weston", None, None],
                [126, "Nigel Martin", 611, "2021", "NEW", None, "Nigel Martin", "N"],
                [261, "Nigl", 4, "2023", "NEW", None, "nigel martin", None],
                [307, "X", 7, "2022", "IGNORE", None, None, None],
                [306, "Training", 1, "2022", None, None, None, None],
            ],
        )
    )
    assert "(121, 'MAP', 'Nick Weston', NULL, false, '{}'::text[])" in sql
    assert "(126, 'NEW', NULL, 'Nigel Martin', false, '{}'::text[])" in sql
    assert "(261, 'NEW', NULL, 'nigel martin', false, '{}'::text[])" in sql
    assert "307" not in sql and "306" not in sql
    assert sql.startswith("-- migrate:up")
    assert "-- migrate:down" in sql


def test_additional_people_become_an_array(tmp_path):
    row = [
        142,
        "Sam Nigel",
        7,
        "",
        "MAP",
        "Sam Lister",
        None,
        None,
        None,
        None,
        None,
        None,
        "Nigel Adams, Joe Hopkinson",
    ]
    sql = opmap.convert(sheet(tmp_path, [row]))
    assert (
        "(142, 'MAP', 'Sam Lister', NULL, false, ARRAY['Nigel Adams', 'Joe Hopkinson']::text[])"
        in sql
    )
    assert "INSERT INTO operation_additional_operators" in sql
    assert "INSERT INTO session_additional_operators" in sql


def test_quotes_are_escaped(tmp_path):
    sql = opmap.convert(
        sheet(tmp_path, [[1, "O'Brien", 2, "", "NEW", None, "Pat O'Brien", "Y"]])
    )
    assert "'Pat O''Brien', true, '{}'::text[])" in sql


@pytest.mark.parametrize(
    "row,msg",
    [
        ([1, "A", 1, "", "MAP", None, None, None], "MAP needs a person"),
        ([1, "A", 1, "", "NEW", None, None, None], "NEW needs a name"),
        ([1, "A", 1, "", "MAYBE", None, None, None], "unknown action"),
    ],
)
def test_invalid_rows_are_rejected(tmp_path, row, msg):
    with pytest.raises(ValueError, match=msg):
        opmap.convert(sheet(tmp_path, [row]))
