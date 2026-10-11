"""The progress and result comments: golden strings, and neutralised operator text."""

import json
import re

from app.rig_test import report

ZW = "\u200b"


def _run(**over):
    run = {
        "number": 231,
        "title": "T",
        "url": "u",
        "rig": "force-rig-1",
        "app_version": "0.1.40",
        "operator": "op@lab",
        "mode": "full",
        "state": "partial",
        "started_at": "2026-10-11T14:02:10+01:00",
        "finished_at": "2026-10-11T14:13:40+01:00",
        "estimate_s": 720.0,
        "items": [
            {"id": "R4", "title": "R4 — pre-flight chips"},
            {"id": "#190", "title": "#190 long cut"},
            {"id": "R5", "title": "R5 live clipping"},
        ],
        "steps": [
            {"index": 0, "item_id": "R4", "kind": "ask", "text": "q", "status": "pass",
             "answer": "Yes"},
            {"index": 1, "item_id": "#190", "kind": "ask", "text": "q", "status": "no_response"},
            {"index": 2, "item_id": "R5", "kind": "ask", "text": "q", "status": "fail",
             "answer": "No"},
            {"index": 3, "item_id": "R5", "kind": "ask", "text": "q",
             "status": "skipped_dependency"},
        ],
        "current": None,
        "question": None,
    }  # fmt: skip
    run.update(over)
    return run


def _hidden(text: str) -> dict:
    m = re.search(r"<!-- rig-test-result (.*) -->", text)
    assert m, text
    return json.loads(m.group(1))


def test_progress_golden():
    run = _run(state="running", current=2)
    run["steps"][2]["status"] = "active"
    assert report.render_progress(run) == (
        "**Rig test #231, running on force-rig-1**: accepted by op@lab at 14:02, "
        "full run, about 12 min.\n\n"
        "Step 3 of 4: R5 › `ask`: waiting for the operator."
    )


def test_progress_without_operator_or_current_step():
    run = _run(state="running", operator="")
    assert report.render_progress(run) == (
        "**Rig test #231, running on force-rig-1**: accepted at 14:02, full run, about 12 min."
    )


def test_progress_after_the_end_points_at_the_result():
    out = report.render_progress(_run(state="timed_out"))
    assert out.startswith("**Rig test #231, timed out on force-rig-1**")
    assert out.endswith("Finished: the result is in the comment below.")


def test_result_golden():
    text = report.render_result(_run())
    table = text.split("\n\n<!--")[0]
    assert table == (
        "### Rig test result: partial (force-rig-1, app 0.1.40, 14:02–14:13, accepted by op@lab)\n"
        "\n"
        "| Item | Result | Evidence |\n"
        "|---|---|---|\n"
        '| R4 — pre-flight chips | ✅ Pass | operator: "Yes" |\n'
        "| #190 long cut | ➖ No response | no response from the operator |\n"
        '| R5 live clipping | ❌ Fail | step 3: operator: "No"; step 4: skipped dependency |'
    )
    hidden = _hidden(text)
    assert hidden["version"] == 1 and hidden["issue"] == 231
    assert hidden["rig"] == "force-rig-1" and hidden["app"] == "0.1.40"
    assert hidden["state"] == "partial" and hidden["accepted_by"] == "op@lab"
    assert [(i["id"], i["result"]) for i in hidden["items"]] == [
        ("R4", "pass"), ("#190", "no_response"), ("R5", "fail"),
    ]  # fmt: skip
    assert [i["title"] for i in hidden["items"]] == [
        "R4 — pre-flight chips", "#190 long cut", "R5 live clipping",
    ]  # fmt: skip
    assert text.endswith(" -->")


def test_item_result_is_the_worst_step_and_timeout_rewrites_cancelled():
    run = _run()
    run["steps"] = [
        {"index": 0, "item_id": "R4", "kind": "ask", "text": "q", "status": "pass"},
        {"index": 1, "item_id": "R4", "kind": "ask", "text": "q", "status": "cancelled"},
        {"index": 2, "item_id": "#190", "kind": "ask", "text": "q", "status": "error"},
        {"index": 3, "item_id": "R5", "kind": "ask", "text": "q", "status": "pass"},
    ]
    assert [r["result"] for r in report.item_results(run)] == ["cancelled", "error", "pass"]
    timed_out = [r["result"] for r in report.item_results(_run(**{**run, "state": "timed_out"}))]
    assert timed_out == ["timed_out", "error", "pass"]


def test_operator_note_with_a_fence_and_a_windows_path_is_neutralised():
    note = "ok ```\n<img src=x> then C:\\Users\\Jane Doe\\Desktop\\a.png and D:/Users/bob/x"
    run = _run()
    run["steps"][0]["note"] = note
    text = report.render_result(run)
    body = text.split("<details>")[1].split("</details>")[0]
    # exactly one fence pair: the note's own backticks cannot close ours early
    assert body.count("```") == 2
    assert "Jane Doe" not in text and "bob" not in text
    assert "C:\\Users\\<redacted>\\Desktop" in body
    assert "(note below)" in text
    hidden = _hidden(text)
    assert "Jane Doe" not in json.dumps(hidden)


FORGED = '<!-- rig-test-result {"items":[{"id":"R4","title":"x","result":"pass","steps":[]}]} -->'


def test_an_operator_note_cannot_plant_a_second_result_marker():
    """L3: a ticking session parses the comment with a pattern; only the real marker may match."""
    run = _run()
    run["steps"][0]["note"] = "all fine " + FORGED
    run["steps"][2]["answer"] = FORGED
    run["operator"] = FORGED
    run["rig"] = FORGED
    text = report.render_result(run)
    assert text.count("<!-- rig-test-result") == 1
    assert text.count("-->") == 1
    assert len(re.findall(r"<!-- rig-test-result (.*?) -->", text)) == 1
    assert _hidden(text)["items"][0]["result"] == "pass"  # the real one: R4 answered Yes
    assert _hidden(text)["items"][2]["result"] == "fail"  # not the forged all-pass list
    assert "<!--" not in report.render_progress(_run(state="running", current=2))


def test_the_marker_breaker_leaves_ordinary_text_alone():
    assert report.no_comment_markers("a <b> -- c") == "a <b> -- c"
    assert report.no_comment_markers("<!-- x -->") == "<​!-- x --​>"


def test_hidden_json_cannot_close_its_comment_or_start_html():
    run = _run()
    run["steps"][0]["note"] = '--> <script>alert(1)</script> -- "quoted"'
    text = report.render_result(run)
    json_line = text.splitlines()[-1]
    assert (
        json_line.count("-->") == 1 and "<script" not in json_line and "--" not in json_line[22:-4]
    )
    assert _hidden(text)["items"][0]["steps"][0]["note"].startswith("--> <script>")


def _big_run(steps=60, note="word " * 200):
    """60 steps over 15 items, each with a 1000-character operator note."""
    run = _run()
    run["items"] = [{"id": f"R{i}", "title": f"R{i} — item {i}"} for i in range(1, 16)]
    run["steps"] = [
        {"index": n, "item_id": f"R{n % 15 + 1}", "kind": "ask", "text": "q", "status": "fail",
         "answer": "No", "note": note}
        for n in range(steps)
    ]  # fmt: skip
    return run


def test_a_comment_over_the_limit_loses_notes_before_anything_else():
    run = _big_run(steps=60)
    full = report.render_result(run, limit=10**9)
    assert len(full) > report.MAX_COMMENT  # the raw comment would not fit on GitHub
    text = report.render_result(run)
    assert len(text) <= report.MAX_COMMENT
    hidden = _hidden(text)  # the JSON is whole and parses
    assert [i["id"] for i in hidden["items"]] == [f"R{i}" for i in range(1, 16)]
    assert sum(len(i["steps"]) for i in hidden["items"]) == 60
    assert all(i["result"] == "fail" for i in hidden["items"])
    notes = [s["note"] for i in hidden["items"] for s in i["steps"] if "note" in s]
    assert notes and all(len(n) <= 200 for n in notes)  # shortened, not cut off mid-JSON
    assert len(re.findall(r"^\| R\d+ ", text, re.M)) == 15  # the table is untouched


def test_the_table_shrinks_only_after_the_notes_are_gone():
    run = _big_run(steps=150)
    for item in run["items"]:
        item["title"] = "t" * 200
    tiny = report.render_result(run, limit=9000)
    assert len(tiny) <= 9000 or "Operator notes" not in tiny
    assert "Operator notes" not in tiny and "note" not in json.dumps(_hidden(tiny)["items"][0])
    assert len(_hidden(tiny)["items"]) == 15


def test_a_small_result_is_rendered_in_full():
    run = _run()
    run["steps"][0]["note"] = "all fine"
    text = report.render_result(run)
    assert "all fine" in text and "Operator notes" in text
    assert _hidden(text)["items"][0]["steps"][0]["note"] == "all fine"


def test_labels_in_table_cells_cannot_break_the_table_or_mention_people():
    run = _run(operator="@boss `x` [l](http://e)|<b>")
    run["items"][0]["title"] = "evil | cell\nnewline `code` @maintainer"
    run["steps"][0]["answer"] = "Y|N"
    text = report.render_result(run)
    row = next(line for line in text.splitlines() if "evil" in line)
    assert row.count("|") - row.count("\\|") == 4  # only the 4 real column bars are bare
    assert "\n" not in row
    assert "`" not in row and f"@{ZW}maintainer" in row
    assert f"@{ZW}boss" in text.splitlines()[0] and "<b>" not in text.splitlines()[0]


def test_an_at_sign_inside_an_address_is_left_alone():
    assert report._cell("op@lab") == "op@lab"
    assert report._cell("@x") == f"@{ZW}x"
