"""Parsing the backlog into a catalogue and an issue body into runnable steps (phase 1)."""

import pytest

from app.rig_test import catalog
from app.rig_test.catalog import RigRequestError, parse_items, parse_request

from .test_rig_test_support import BODY

# Real snippets from docs/runbooks/physical-test-backlog.md (shortened).
BACKLOG = """\
## B. Force rig

### Recording
- [ ] **R4 — pre-flight chips.** With the Lab Amp in MEASURE: Amp chip OK. In RESET: OK (Start
  cycles it). Unplugged/unreachable: warning. Since #124.
  — 2026-10-08, DP at the rig: FAIL on the unplugged amp, see #215.
- [x] **#190 long cut links and keeps its crop.** Record a cut over ~6 min at 51.2 kHz (no .mat).
  Move both crop handles in the final summary and Save. Since #198 (0.1.35).
- [ ] **Leaving the page mid-cut.** Go to Plot and back; the trace has no hole.
- [ ] **R4 — a second item with the same id.** The first R4 must win.
- [ ] **#96, #101** Explorer reveal and network-drive behaviour.
- [ ] **R7 — chips with a block.** Pull the cable.
  ```rig-test
  id: R7
  steps:
    - ask: Pull the Lab Amp's network cable. Does the Amp chip warn within 10 s?
      options: [Yes, "No - still OK", Couldn't do it]
      pass: [Yes]
      est: 90s
    - ask: Plug the cable back in.
      options: [Done]
      est: 30s
    - note: Wait for the chip to go green.
    - ask: Is the chip green again?
      options: [Yes, No]
      pass: [Yes]
      after: 2
  ```

## C. d1-server
- [ ] **C1 — not a rig item.** Something else.
"""


@pytest.fixture
def index():
    return catalog._index(BACKLOG)


def test_item_ids_come_from_the_bold_lead():
    items = parse_items(BACKLOG)
    assert [i.id for i in items] == ["R4", "#190", None, "R4", "#96", "R7", "C1"]
    assert items[0].title == "R4 — pre-flight chips"
    assert items[4].title == "#96, #101"


def test_first_occurrence_of_an_id_wins(index):
    assert index["R4"].title == "R4 — pre-flight chips"
    assert None not in index  # an item with no id cannot be requested


def test_prose_is_one_line_without_markup_and_item_ends_at_the_next_checkbox(index):
    prose = index["R4"].prose
    assert prose.startswith("R4 — pre-flight chips. With the Lab Amp in MEASURE")
    assert "**" not in prose and "\n" not in prose
    assert "Leaving the page" not in prose
    assert "#190 long cut" not in prose


def test_ticked_items_are_catalogued_too(index):
    assert "#190" in index


def test_item_without_a_block_becomes_one_ask_with_pass_fail_skip(index):
    req = parse_request(BODY.format(block='items: [R4, "#190"]'), index)
    assert [i.id for i in req.items] == ["R4", "#190"]
    steps = req.steps
    assert [s.index for s in steps] == [0, 1]
    first = steps[0]
    assert first.kind == "ask" and first.item_id == "R4"
    assert first.options == ["Pass", "Fail", "Skip"] and first.pass_ == ["Pass"]
    assert first.text.startswith("R4 — pre-flight chips.")
    assert first.est_s == 120


def test_long_prose_is_cut_to_the_text_bound():
    long_item = "- [ ] **R9 — long.** " + "word " * 600
    req = parse_request(BODY.format(block="items: [R9]"), catalog._index(long_item))
    text = req.steps[0].text
    assert len(text) <= catalog.MAX_TEXT and text.endswith("…")


def test_item_block_steps_options_pass_est_and_after(index):
    req = parse_request(BODY.format(block="items: [R7]"), index)
    s = req.steps
    assert [x.kind for x in s] == ["ask", "ask", "note", "ask"]
    assert s[0].options == ["Yes", "No - still OK", "Couldn't do it"] and s[0].pass_ == ["Yes"]
    assert s[0].est_s == 90
    assert s[1].options == ["Done"] and s[1].pass_ == ["Done"]  # a single option passes
    assert s[2].options is None and s[2].est_s == 30
    assert s[3].after == 1  # item-local step 2 -> request index 1
    assert s[3].options == ["Yes", "No"]  # unquoted Yes/No stay text, not booleans


def test_after_uses_request_wide_indexes_for_later_items(index):
    req = parse_request(BODY.format(block="items: [R4, R7]"), index)
    after = [s for s in req.steps if s.after is not None]
    assert after[0].index == 4 and after[0].after == 2  # R4 has one step, so R7's step 2 is 2


def test_estimates_and_operator_step_count(index):
    req = parse_request(BODY.format(block="items: [R4, R7]"), index)
    assert req.estimate_s == {"full": 120 + 90 + 30 + 30 + 120, "automated": 0}
    assert req.needs_operator_steps == 5


def test_request_contract_shape(index):
    req = parse_request(BODY.format(block="rig: Rig-1\nitems: [R7]"), index)
    out = req.as_request(7, {"title": "T", "url": "u", "requested_by": "me", "created_at": "c"})
    assert set(out) == {
        "number", "title", "url", "requested_by", "created_at", "items", "estimate_s",
        "needs_operator_steps",
    }  # fmt: skip
    step = out["items"][0]["steps"][0]
    assert step["pass"] == ["Yes"] and "pass_" not in step and "after" not in step
    assert req.rig == "Rig-1"


@pytest.mark.parametrize("kind", ["do: labamp.set_mode\n    mode: MEASURE", "do: record"])
def test_do_actions_are_refused_until_phase_2(kind):
    block = f"steps:\n  - ask: first\n  - {kind}"
    with pytest.raises(RigRequestError, match="arrives in phase 2"):
        parse_request(BODY.format(block=block), {})


def test_action_name_in_the_error_cannot_carry_markup():
    block = 'steps:\n  - do: "x`<b>@evil"'
    with pytest.raises(RigRequestError) as e:
        parse_request(BODY.format(block=block), {})
    assert "`" not in str(e.value) and "<" not in str(e.value) and "@" not in str(e.value)


@pytest.mark.parametrize(
    "step",
    ["- run: rm -rf /", "- shell: calc", "- ask: a\n    note: b", "- {}", "- ask: a\n    extra: 1"],
)
def test_unknown_or_ambiguous_step_kinds_are_invalid(step):
    with pytest.raises(RigRequestError):
        parse_request(BODY.format(block=f"steps:\n  {step}"), {})


def test_bounds():
    def bad(block):
        with pytest.raises(RigRequestError):
            parse_request(BODY.format(block=block), {})

    bad("steps:\n  - ask: " + "x" * 1001)  # text too long
    bad("steps:\n  - ask: ok\n    options: [a, b, c, d, e, f, g]\n    pass: [a]")  # 7 options
    bad("steps:\n" + "  - note: hi\n" * 51)  # 51 steps in a block
    bad("items: [" + ", ".join(f"I{n}" for n in range(21)) + "]")  # 21 items
    bad("steps:\n  - ask: ok\n    est: 3h")  # estimate out of range
    bad("steps:\n  - ask: ok\n    est: 2000")
    bad("steps:\n  - ask: ok\n    options: [A, B]")  # pass is required with several options
    bad("steps:\n  - ask: ok\n    options: [A]\n    pass: [Z]")  # pass not among options
    bad("steps:\n  - ask: ok\n    after: 1")  # after must name an earlier step
    bad("steps:\n  - note: n\n    options: [A]")  # a note takes no options
    bad("bogus: 1\nitems: [R4]")  # unknown top-level key
    bad("rig: x\n")  # names nothing


def test_the_text_limit_itself_is_accepted():
    req = parse_request(BODY.format(block="steps:\n  - ask: " + "x" * 1000), {})
    assert len(req.steps[0].text) == 1000
    assert req.items[0].id == "inline"


def test_inline_note_and_ask_estimates():
    block = (
        "steps:\n  - note: look\n  - ask: ok\n  - ask: slow\n    est: 2m\n  - ask: s\n    est: 45"
    )
    req = parse_request(BODY.format(block=block), {})
    assert [s.est_s for s in req.steps] == [30, 120, 120, 45]


def test_unknown_item_names_the_id():
    with pytest.raises(RigRequestError, match="unknown item 'Z9'"):
        parse_request(BODY.format(block="items: [Z9]"), {})


def test_body_without_or_with_two_blocks_is_invalid():
    with pytest.raises(RigRequestError, match="no ```rig-test"):
        parse_request("just words", {})
    two = BODY.format(block="items: [R4]") + BODY.format(block="items: [R4]")
    with pytest.raises(RigRequestError, match="more than one"):
        parse_request(two, {})


def test_yaml_aliases_and_huge_blocks_are_refused():
    bomb = "a: &a [x, x, x]\nb: &b [*a, *a, *a]\nitems: [*b]"
    with pytest.raises(RigRequestError):
        parse_request(BODY.format(block=bomb), {})
    with pytest.raises(RigRequestError, match="longer than"):
        parse_request(BODY.format(block="items: [R4]\n# " + "x" * 17000), {})


def test_a_broken_catalogue_block_makes_only_requests_for_it_invalid():
    md = "- [ ] **R1 — bad.** x\n  ```rig-test\n  steps:\n    - do: record\n  ```\n- [ ] **R2 — fine.** y\n"
    index = catalog._index(md)
    with pytest.raises(RigRequestError, match="R1.*phase 2"):
        parse_request(BODY.format(block="items: [R1]"), index)
    assert parse_request(BODY.format(block="items: [R2]"), index).steps[0].item_id == "R2"


def test_duplicate_item_ids_in_one_request_run_once(index):
    req = parse_request(BODY.format(block="items: [R4, R4]"), index)
    assert [i.id for i in req.items] == ["R4"]


def test_peek_rig_never_raises():
    assert catalog.peek_rig(BODY.format(block="rig: force-rig-1\nitems: [R4]")) == "force-rig-1"
    assert catalog.peek_rig(BODY.format(block="items: [R4]")) is None
    assert catalog.peek_rig("no block") is None
    assert catalog.peek_rig(BODY.format(block=": : :\n - [")) is None


def test_the_real_backlog_resolves_r4_and_190():
    text = catalog.REPO_BACKLOG.read_text(encoding="utf-8")
    index = catalog._index(text)
    assert {"R4", "#190"} <= set(index)
    assert catalog._index(text) is index  # cached by content
    req = parse_request(BODY.format(block='items: [R4, "#190"]'), index)
    assert req.steps[0].text.startswith("R4")
    assert all(len(s.text) <= catalog.MAX_TEXT for s in req.steps)


def test_catalog_falls_back_to_the_repo_backlog_when_no_bundled_copy(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", tmp_path / "missing.md")
    assert "R4" in catalog.catalog_index()
    monkeypatch.setattr(catalog, "REPO_BACKLOG", tmp_path / "also-missing.md")
    assert catalog.load_catalog_text() == ""
