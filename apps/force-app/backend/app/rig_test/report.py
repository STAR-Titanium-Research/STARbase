"""The comments a rig test leaves on its issue (spec, "Report format").

The progress comment is edited in place; the result comment is new, so GitHub notifies the
maintainer, and ends with a hidden JSON block that a ticking session parses.

Everything typed by a person (operator notes, option labels, the operator's name) is untrusted
in a GitHub comment: it could close our fence, add a link or @-mention someone, or leak a Windows
account name. Free-text notes only ever appear inside a fenced block built by
`bug_report._fence` with paths redacted; short labels in table cells are neutralised by `_cell`.
"""

from __future__ import annotations

import json
import re

from ..bug_report import _fence, _redact_paths

SCHEMA_VERSION = 1
NOTE_LIMIT = 1000
CELL_LIMIT = 160
EVIDENCE_LIMIT = 300

RESULT_LABELS = {
    "pass": "✅ Pass",
    "fail": "❌ Fail",
    "no_response": "➖ No response",
    "skipped_dependency": "⏭ Skipped (earlier step not done)",
    "cancelled": "🚫 Cancelled",
    "timed_out": "⏱ Timed out",
    "error": "⚠️ Error",
}
# When an item's steps disagree, the worst one is the item's result.
_WORST_FIRST = ("fail", "error", "timed_out", "cancelled", "no_response", "skipped_dependency")


def _cell(text: object, limit: int = CELL_LIMIT) -> str:
    """One short label made safe for a markdown table cell: no pipes, line breaks, code spans,
    HTML, links or @-mentions, and no Windows account names."""
    s = re.sub(r"\s+", " ", _redact_paths(str(text))).strip()
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    for raw, safe in (
        ("&", "&amp;"),
        ("<", "&lt;"),
        (">", "&gt;"),
        ("|", "\\|"),
        ("`", "'"),
        ("[", "\\["),
        ("]", "\\]"),
        ("@", "@​"),
    ):
        s = s.replace(raw, safe)
    return s


def _hhmm(iso: str | None) -> str:
    return iso[11:16] if iso and len(iso) >= 16 else "?"


def _minutes(seconds: float) -> int:
    return max(1, round(seconds / 60))


def item_results(run: dict) -> list[dict]:
    """[{id, title, result, steps:[{index, kind, status, answer?, note?}]}] from a run record."""
    out = []
    for item in run["items"]:
        steps = [s for s in run["steps"] if s["item_id"] == item["id"]]
        statuses = {s["status"] for s in steps}
        result = next((r for r in _WORST_FIRST if r in statuses), "pass")
        if result == "cancelled" and run["state"] == "timed_out":
            result = "timed_out"
        out.append(
            {
                "id": item["id"],
                "title": item["title"],
                "result": result,
                "steps": [
                    {k: s[k] for k in ("index", "kind", "status", "answer", "note") if k in s}
                    for s in steps
                ],
            }
        )
    return out


def counts(run: dict) -> dict[str, int]:
    tally: dict[str, int] = {}
    for s in run["steps"]:
        tally[s["status"]] = tally.get(s["status"], 0) + 1
    return tally


def _by(run: dict) -> str:
    return f" by {_cell(run['operator'], 80)}" if run.get("operator") else ""


def render_progress(run: dict) -> str:
    n = len(run["steps"])
    head = (
        f"**Rig test #{run['number']}, {run['state'].replace('_', ' ')} on {_cell(run['rig'], 80)}**: "
        f"accepted{_by(run)} at {_hhmm(run['started_at'])}, "
        f"full run, about {_minutes(run['estimate_s'])} min."
    )
    cur = run.get("current")
    if run["state"] != "running":
        return f"{head}\n\nFinished: the result is in the comment below."
    if cur is None:
        return head
    step = run["steps"][cur]
    doing = "waiting for the operator" if step["status"] == "active" else step["status"]
    return f"{head}\n\nStep {cur + 1} of {n}: {_cell(step['item_id'], 40)} › `{step['kind']}`: {doing}."


def _evidence(steps: list[dict]) -> tuple[str, list[tuple[str, str]]]:
    """(table text, [(step label, note)]) for one item's steps."""
    multi = len(steps) > 1
    parts, notes = [], []
    for s in steps:
        label = f"step {s['index'] + 1}: " if multi else ""
        status = s["status"]
        if status in ("pass", "fail") and s.get("answer") is not None:
            what = f'operator: "{_cell(s["answer"], 60)}"'
        elif status == "no_response" and s.get("answer") is not None:
            what = f'operator: "{_cell(s["answer"], 60)}" (no result)'
        elif status == "no_response":
            what = "no response in 5 min"
        else:
            what = status.replace("_", " ")
        if s.get("note"):
            notes.append((f"step {s['index'] + 1}", s["note"]))
            what += " (note below)"
        parts.append(label + what)
    text = "; ".join(parts)
    return (text if len(text) <= EVIDENCE_LIMIT else text[: EVIDENCE_LIMIT - 1] + "…"), notes


def _hidden_json(run: dict, results: list[dict]) -> str:
    payload = {
        "version": SCHEMA_VERSION,
        "issue": run["number"],
        "rig": run["rig"],
        "app": run["app_version"],
        "state": run["state"],
        "started_at": run["started_at"],
        "finished_at": run.get("finished_at"),
        "accepted_by": run.get("operator") or None,
        "items": [
            {
                "id": r["id"],
                "result": r["result"],
                "steps": [
                    {
                        **s,
                        **({"note": _redact_paths(s["note"])[:NOTE_LIMIT]} if "note" in s else {}),
                    }
                    for s in r["steps"]
                ],
            }
            for r in results
        ],
    }
    text = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    # Keep the JSON from closing its own HTML comment, whatever the notes contain.
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("--", "-\\u002d")


def render_result(run: dict) -> str:
    results = item_results(run)
    notes: list[tuple[str, str]] = []
    rows = []
    for r in results:
        steps = [s for s in run["steps"] if s["item_id"] == r["id"]]
        evidence, item_notes = _evidence(steps)
        notes += [(f"{_cell(r['id'], 40)} {where}", text) for where, text in item_notes]
        rows.append(f"| {_cell(r['title'], 80)} | {RESULT_LABELS[r['result']]} | {evidence} |")
    lines = [
        f"### Rig test result: {run['state']} ({_cell(run['rig'], 80)}, app {_cell(run['app_version'], 40)}, "
        f"{_hhmm(run['started_at'])}–{_hhmm(run.get('finished_at'))}, accepted{_by(run)})",
        "",
        "| Item | Result | Evidence |",
        "|---|---|---|",
        *rows,
    ]
    if notes:
        lines += ["", "<details><summary>Operator notes</summary>", ""]
        for where, text in notes:
            lines += [f"**{where}**", "", *_fence(_redact_paths(text), NOTE_LIMIT), ""]
        lines += ["</details>"]
    lines += ["", f"<!-- rig-test-result {_hidden_json(run, results)} -->"]
    return "\n".join(lines)
