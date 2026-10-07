"""scripts/migrate_legacy.py: pure helpers (findings 7.4-7.7) and, with DATABASE_URL pointing at
a migrated database, DB-level behaviour. DB tests run inside a transaction that is rolled back.
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

pytest.importorskip("openpyxl")
pytest.importorskip("psycopg2")

import migrate_legacy as ml  # noqa: E402

# ---- clean_str (7.5) ------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["Na", " Na ", "Ti", "Nb", "Namibia"])
def test_clean_str_keeps_sodium_and_ordinary_values(raw):
    assert ml.clean_str(raw) == raw.strip()


@pytest.mark.parametrize(
    "raw", [None, "", "  ", "none", "None", "N/A", "n/a", "na", "NA"]
)
def test_clean_str_drops_null_tokens(raw):
    assert ml.clean_str(raw) is None


# ---- clean_float (7.7) -----------------------------------------------------------------


def test_clean_float_keeps_zero():
    assert ml.clean_float(0) == 0.0
    assert ml.clean_float("0.0") == 0.0
    assert ml.clean_float(0.0) is not None


@pytest.mark.parametrize("raw", [None, "", "abc", "n/a"])
def test_clean_float_none_for_blank_or_garbage(raw):
    assert ml.clean_float(raw) is None


def test_clean_float_parses_numbers():
    assert ml.clean_float("2.5") == 2.5
    assert ml.clean_float(3) == 3.0


# ---- sodium survives into the alloying-element junction (7.5) ----------------------------


class _Cur:
    def __init__(self, rows):
        self.rows = rows
        self.q = ""

    def execute(self, sql, params=None):
        self.q = sql

    def fetchall(self):
        return self.rows


def test_sodium_is_not_dropped_from_alloying_elements(monkeypatch):
    captured = {}

    def fake_execute_values(cur, sql, data, **kw):
        captured["sql"], captured["data"] = sql, list(data)

    monkeypatch.setattr(ml.psycopg2.extras, "execute_values", fake_execute_values)

    class Cur(_Cur):
        def execute(self, sql, params=None):
            self.q = sql

        def fetchall(self):
            if "FROM alloying_elements" in self.q:
                return [("Na",), ("Al",), ("Ti",)]
            return [("X1", "11111111-1111-1111-1111-111111111111")]

    n = ml.load_material_elements(
        Cur([]), [{"Code": "X1", "Alloying Elements": "Na, Al, n/a, na, Ti"}], dry=False
    )
    assert n == 3
    assert sorted(sym for _m, sym in captured["data"]) == ["Al", "Na", "Ti"]


# ---- upserts never overwrite live values (7.7) -------------------------------------------


def _upserts():
    src = open(ml.__file__, encoding="utf-8").read()
    blocks = []
    for stmt in re.findall(r'"""\s*INSERT INTO.*?"""', src, flags=re.S):
        m = re.search(r"DO UPDATE SET(.*)\"\"\"$", stmt, flags=re.S)
        if m:
            blocks.append(m.group(1))
    return blocks


def test_every_do_update_assignment_keeps_the_existing_value():
    blocks = _upserts()
    assert blocks, "no upserts found"
    for block in blocks:
        for assignment in re.split(r",\s+(?=\w+\s*=)", " ".join(block.split())):
            assignment = re.sub(
                r"\s+(WHERE|RETURNING)\s.*$", "", assignment
            )  # row filter, not a value
            m = re.match(r"\s*(\w+)\s*=\s*(.*)", assignment, flags=re.S)
            assert m, assignment
            col, rhs = m.groups()
            rhs = " ".join(rhs.split())
            assert re.match(
                rf"COALESCE\((\w+)\.{col},\s*EXCLUDED\.{col}\)$", rhs
            ), f"{col} = {rhs} may overwrite an existing value"


def test_module_docstring_matches_the_rerun_behaviour():
    assert "never overwrites" in ml.__doc__


# ---- DB-level: owners via people, real user ids, reruns, no box expansion ---------------

DSN = os.environ.get("DATABASE_URL")
OWNER_EMAIL = "owner.legacy.test@example.org"
CO_EMAIL = "co.legacy.test@example.org"
OPERATOR = "Olive Operator"


def _sheets():
    return {
        "alloying_elements": [
            {
                "Symbol": "Na",
                "Name": "Sodium",
                "Atomic Number": 11,
                "Atomic Weight": 22.99,
            }
        ],
        "alloy_codes": [
            {
                "Code": "ZZ-LEG",
                "Alloy": "Legacy Test Alloy",
                "Density": 0,
                "Alloying Elements": "Na",
            }
        ],
        "machines": [{"Machine": "Legacy Test Rig", "Type": "FAST"}],
        "tools": [],
        "insert_types": [],
        "operation": [],
        "mfg_codes": [],
        "boxes": [
            {
                "Box ID": "zzbox1",
                "Owner": OWNER_EMAIL,
                "Package Quantity": 5,
                "Location": "Shelf 1",
            }
        ],
        "inserts": [
            {
                "Unique ID": "zzi1",
                "Insert Box": "zzbox1",
                "Position In Box": 1,
                "Owner": OWNER_EMAIL,
            },
            {
                "Unique ID": "zzi2",
                "Insert Box": "zzbox1",
                "Position In Box": 2,
                "Status": "Used",
            },
        ],
        "edges": [],
        "inventory": [
            {
                "Unique ID": "zzs1",
                "Item Code": "ZZ-LEG-S1",
                "Alloy": "Legacy Test Alloy",
                "Geometry": "cube",
                "Owner": OWNER_EMAIL,
                "Co-owners": CO_EMAIL,
                "Manufacturing Operation ID": "zzf1",
                "Notes": "from the sheet",
            }
        ],
        "fast_runs": [
            {"Unique ID": "zzf1", "Machine": "Legacy Test Rig", "User": OPERATOR}
        ],
        "machining_ops": [
            {
                "Unique ID": "zzm1",
                "Workpiece ID": "zzs1",
                "Operation": "Turning",
                "User": OWNER_EMAIL,
                "RPM": 1000,
                "Abs Pass #": 3,
            }
        ],
        "users": [
            {"Email": OWNER_EMAIL, "First Name": "Olive", "Last Name": "Owner"},
            {"Email": CO_EMAIL, "First Name": "Cora", "Last Name": "Coowner"},
        ],
    }


@pytest.fixture
def cur():
    import psycopg2

    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        conn = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    c = conn.cursor()
    c.execute("SELECT to_regclass('people'), to_regclass('sample_co_owners')")
    if None in c.fetchone():
        conn.close()
        pytest.skip("database is not migrated")
    # Real Directus has UNIQUE(email) (the script's ON CONFLICT target); the migration
    # stub of directus_users does not. Add it inside the test transaction if missing.
    c.execute(
        "SELECT 1 FROM pg_index WHERE indrelid='directus_users'::regclass AND indisunique "
        "AND indnatts=1 AND indkey[0] = (SELECT attnum FROM pg_attribute "
        "WHERE attrelid='directus_users'::regclass AND attname='email')"
    )
    if c.fetchone() is None:
        c.execute(
            "ALTER TABLE directus_users ADD CONSTRAINT du_email_uq UNIQUE (email)"
        )
    yield c
    conn.rollback()  # everything the test wrote disappears
    conn.close()


def _one(cur, sql, *params):
    cur.execute(sql, params)
    return cur.fetchone()


def test_owners_are_written_through_people_and_existing_users_keep_their_id(cur):
    import uuid

    existing = str(uuid.uuid4())  # not the uuid5 the script would propose
    cur.execute(
        "INSERT INTO directus_users (id, email, first_name, last_name) VALUES (%s, %s, 'Olive', 'Owner')",
        (existing, OWNER_EMAIL),
    )
    cur.execute("SAVEPOINT s")
    ml.migrate(_sheets(), cur, False)

    person = _one(
        cur, "SELECT person_id::text FROM people WHERE user_id = %s", existing
    )
    assert person, "a people row exists for the pre-existing user"
    owner, owner_person = _one(
        cur,
        "SELECT owner::text, owner_person_id::text FROM physical_samples WHERE sample_code='ZZ-LEG-S1'",
    )
    assert owner == existing  # the real id, not the deterministic one
    assert owner_person == person[0]

    co_user, co_person = _one(
        cur,
        "SELECT user_id::text, person_id::text FROM sample_co_owners sc "
        "JOIN physical_samples s USING (sample_id) WHERE s.sample_code='ZZ-LEG-S1'",
    )
    assert (
        co_person
        == _one(cur, "SELECT person_id::text FROM people WHERE user_id=%s", co_user)[0]
    )

    assert (
        _one(
            cur,
            "SELECT owner_person_id::text FROM tool_boxes WHERE tool_box_code='zzbox1'",
        )[0]
        == person[0]
    )
    assert (
        _one(
            cur,
            "SELECT owner_person_id::text FROM cutting_inserts WHERE insert_code LIKE 'zzbox1-#1'",
        )[0]
        == person[0]
    )


def test_box_is_not_expanded_and_blank_status_is_not_depleted(cur):
    ml.migrate(_sheets(), cur, False)
    # exactly the two inserts from the sheet; migration 125's intake expansion did not fire
    assert (
        _one(
            cur,
            "SELECT count(*) FROM cutting_inserts ci JOIN tool_boxes tb USING (tool_box_id) WHERE tb.tool_box_code='zzbox1'",
        )[0]
        == 2
    )
    depleted = dict(
        cur.execute(
            "SELECT insert_number, is_depleted FROM cutting_inserts ci JOIN tool_boxes tb USING (tool_box_id) WHERE tb.tool_box_code='zzbox1'"
        )
        or cur.fetchall()
    )
    assert depleted == {1: False, 2: True}


def test_sodium_and_zero_density_survive_the_load(cur):
    ml.migrate(_sheets(), cur, False)
    assert (
        _one(
            cur,
            "SELECT count(*) FROM material_alloying_elements mae JOIN materials m USING (material_id) WHERE m.alloy_code='ZZ-LEG' AND mae.symbol='Na'",
        )[0]
        == 1
    )
    assert (
        _one(cur, "SELECT density_g_per_cm3 FROM materials WHERE alloy_code='ZZ-LEG'")[
            0
        ]
        == 0
    )


def test_operator_name_resolves_to_a_person(cur):
    sheets = _sheets()
    ml.migrate(sheets, cur, False)  # creates the users and people
    person = _one(
        cur, "SELECT person_id::text FROM people WHERE lower(email)=%s", OWNER_EMAIL
    )[0]
    sheets["fast_runs"][0]["User"] = "Olive Owner"
    # operations use ON CONFLICT DO NOTHING; clear the first run's op so the rerun inserts again
    cur.execute(
        "DELETE FROM manufacturing_operations WHERE operator_name = %s", (OPERATOR,)
    )
    ml.migrate(sheets, cur, False)
    assert (
        _one(
            cur,
            "SELECT operator_person_id::text FROM manufacturing_operations WHERE operator_name='Olive Owner'",
        )[0]
        == person
    )


def test_rerun_does_not_overwrite_live_edits(cur):
    ml.migrate(_sheets(), cur, False)
    cur.execute(
        "UPDATE physical_samples SET form='cylinder', notes='edited in the app', nickname='mine' "
        "WHERE sample_code='ZZ-LEG-S1'"
    )
    cur.execute(
        "UPDATE tool_boxes SET package_quantity=99 WHERE tool_box_code='zzbox1'"
    )
    cur.execute("UPDATE materials SET density_g_per_cm3=7.5 WHERE alloy_code='ZZ-LEG'")
    ml.migrate(_sheets(), cur, False)
    assert _one(
        cur,
        "SELECT form, notes, nickname FROM physical_samples WHERE sample_code='ZZ-LEG-S1'",
    ) == (
        "cylinder",
        "edited in the app",
        "mine",
    )
    assert (
        _one(
            cur, "SELECT package_quantity FROM tool_boxes WHERE tool_box_code='zzbox1'"
        )[0]
        == 99
    )
    assert (
        float(
            _one(
                cur, "SELECT density_g_per_cm3 FROM materials WHERE alloy_code='ZZ-LEG'"
            )[0]
        )
        == 7.5
    )


def test_machining_and_fast_parameters_land_in_the_inline_columns(cur):
    ml.migrate(_sheets(), cur, False)
    assert _one(
        cur,
        "SELECT process_category, machining_operation_subtype, machining_spindle_speed_rpm, "
        "operator_person_id IS NOT NULL FROM manufacturing_operations "
        "WHERE machining_legacy_machining_uid='zzm1'",
    ) == ("machining", "turning", 1000, True)
    assert _one(
        cur,
        "SELECT process_category FROM manufacturing_operations WHERE operator_name=%s",
        OPERATOR,
    ) == ("sintering",)


def test_imported_operations_keep_their_own_sequence_numbers(cur):
    # The operation trigger auto-numbers only rows with source_system NULL. The importer tags its
    # rows, so the FAST run keeps a NULL sequence and the machining pass keeps its explicit number
    # instead of colliding with an auto-assigned one (migration 126).
    ml.migrate(_sheets(), cur, False)
    cur.execute(
        "SELECT o.process_category, o.operation_sequence, o.source_system "
        "FROM manufacturing_operations o JOIN physical_samples s USING (sample_id) "
        "WHERE s.sample_code = 'ZZ-LEG-S1' ORDER BY o.process_category"
    )
    assert cur.fetchall() == [
        ("machining", 3, "legacy_migration"),
        ("sintering", None, "legacy_migration"),
    ]
    cur.execute(
        "SELECT count(*) FROM (SELECT sample_id, operation_sequence "
        "FROM manufacturing_operations WHERE operation_sequence IS NOT NULL "
        "GROUP BY 1, 2 HAVING count(*) > 1) d"
    )
    assert cur.fetchone() == (0,)


def test_dry_run_reads_a_workbook_and_touches_no_database(
    tmp_path, monkeypatch, capsys
):
    import openpyxl

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    sheets = _sheets()
    for key, name, _required in ml.SHEETS:
        ws = wb.create_sheet(name)
        rows = sheets[key]
        headers = sorted({h for r in rows for h in r}) or ["Placeholder"]
        ws.append(headers)
        for r in rows:
            ws.append([r.get(h) for h in headers])
    path = tmp_path / "legacy.xlsx"
    wb.save(path)

    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(
        sys, "argv", ["migrate_legacy.py", "--xlsx", str(path), "--dry-run"]
    )
    ml.main()
    out = capsys.readouterr().out
    assert "physical_samples" in out and "Migration complete" in out


# ---- transfer_sample_ownership.py + legacy_people ------------------------------------------


def test_people_index_resolves_email_and_unique_name_but_not_ambiguous_names():
    from legacy_people import load_index

    class C:
        def execute(self, sql, params=None):
            pass

        def fetchall(self):
            return [
                ("p1", "u1", "a@x.org", "a@x.org", "ann one"),
                ("p2", None, None, None, "bob two"),
                ("p3", "u3", "c1@x.org", None, "same name"),
                ("p4", "u4", "c2@x.org", None, "same name"),
            ]

    idx = load_index(C())
    assert idx.resolve_owner("A@X.org ") == ("u1", "p1")
    assert idx.resolve_owner("Ann  One") == ("u1", "p1")
    assert idx.resolve_owner("bob two") == (None, "p2")  # a person without a login
    assert idx.resolve_owner("same name") == (None, None)  # ambiguous: no guess
    assert idx.resolve_owner("c2@x.org") == ("u4", "p4")
    assert idx.resolve_owner(None) == (None, None)


def test_transfer_sets_owner_person_and_legacy_owner(cur):
    import uuid

    import transfer_sample_ownership as tso
    from legacy_people import ensure_people, load_index

    user = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO directus_users (id, email, first_name, last_name) "
        "VALUES (%s, 'transfer.test@example.org', 'Tessa', 'Transfer')",
        (user,),
    )
    ensure_people(cur, [user])
    cur.execute(
        "INSERT INTO physical_samples (sample_code, form) VALUES ('ZZ-TRANSFER-1', 'cube'), "
        "('ZZ-TRANSFER-2', 'cube')"
    )
    inventory = [
        {"Item Code": "ZZ-TRANSFER-1", "Owner": "Tessa Transfer"},  # by sheet name
        {"Item Code": "ZZ-TRANSFER-2", "Owner": "nobody@example.org"},
    ]
    users = [
        {
            "Email": "transfer.test@example.org",
            "First Name": "Tessa",
            "Last Name": "Transfer",
        }
    ]
    n, unresolved = tso.transfer(cur, users, inventory, load_index(cur))
    assert n == 1 and unresolved == {"nobody@example.org"}
    owner, person = _one(
        cur,
        "SELECT owner::text, owner_person_id::text FROM physical_samples WHERE sample_code='ZZ-TRANSFER-1'",
    )
    assert owner == user
    assert (
        person
        == _one(cur, "SELECT person_id::text FROM people WHERE user_id=%s", user)[0]
    )
