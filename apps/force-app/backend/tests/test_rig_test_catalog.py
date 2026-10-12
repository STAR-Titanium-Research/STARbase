"""Parsing the backlog into a catalogue and an issue body into runnable steps (phase 1)."""

import time

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
- [ ] **R40 — a lookalike.** Its id is its own, not R4.
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
    assert [i.id for i in items] == ["R4", "#190", None, "R40", "#96", "R7", "C1"]
    assert items[0].title == "R4 — pre-flight chips"
    assert items[4].title == "#96, #101"


def test_ids_stop_at_the_real_boundary_and_keep_hyphenated_suffixes():
    md = "\n".join(
        f"- [ ] **{lead}** text"
        for lead in (
            "E5-fix-ui: Edit is hidden where you may not",
            "E5-r2-ui: a refused save shows the server's words",
            "E4-fix — the subject trigger",
            "E5 — migrations 140 and 141",
            "E5 fix — nobody can grant themselves a role",
            "E5-r3 — a parent merely updated",
            "D1/D2 — chips and messages",
            "#96, #101 Explorer reveal",
            "R10: chip",
            "E-final: campaign pickers",
            "Lab Member file reads.",
        )
    )
    assert [i.id for i in parse_items(md)] == [
        "E5-fix-ui", "E5-r2-ui", "E4-fix", "E5", "E5", "E5-r3", "D1", "#96", "R10", None, None,
    ]  # fmt: skip


def test_an_id_naming_several_items_is_an_invalid_request():
    md = "- [ ] **E5 — one.** a\n- [ ] **E5 — two.** b\n- [ ] **E5-fix-ui: three.** c\n"
    index = catalog._index(md)
    assert len(index["E5"]) == 2 and len(index["E5-fix-ui"]) == 1
    with pytest.raises(RigRequestError) as e:
        parse_request(BODY.format(block="items: [E5]"), index)
    assert str(e.value) == "E5 matches 2 items in this app's backlog; ask for one by its full id"
    assert parse_request(BODY.format(block="items: [E5-fix-ui]"), index).items[0].id == "E5-fix-ui"


def test_items_without_an_id_are_not_in_the_index(index):
    assert None not in index  # an item with no id cannot be requested


def test_prose_is_one_line_without_markup_and_item_ends_at_the_next_checkbox(index):
    prose = index["R4"][0].prose
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
    assert first.est_s == catalog.PROSE_EST_S == 600  # "record a cut, check X": 10 min, not 2


def test_prose_steps_may_be_longer_than_request_text_but_not_unbounded():
    medium = "- [ ] **R9 — long.** " + "word " * 600  # ~3000 chars: fine for bundled prose
    req = parse_request(BODY.format(block="items: [R9]"), catalog._index(medium))
    assert 1000 < len(req.steps[0].text) <= catalog.MAX_PROSE_TEXT
    assert not req.steps[0].text.endswith("…")
    huge = "- [ ] **R9 — long.** " + "word " * 3000
    text = parse_request(BODY.format(block="items: [R9]"), catalog._index(huge)).steps[0].text
    assert len(text) <= catalog.MAX_PROSE_TEXT and text.endswith("…")


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
    assert req.estimate_s == {"full": 600 + 90 + 30 + 30 + 120, "automated": 0}
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


def test_deeply_nested_yaml_is_an_invalid_request_not_a_crash():
    with pytest.raises(RigRequestError, match="nested too deeply"):
        parse_request(BODY.format(block="items: " + "[" * 3000), {})
    assert catalog.peek_rig(BODY.format(block="[" * 3000)) is None
    md = "- [ ] **R1 — deep.** x\n  ```rig-test\n  steps: " + "[" * 3000 + "\n  ```\n"
    with pytest.raises(RigRequestError, match="R1.*nested too deeply"):
        parse_request(BODY.format(block="items: [R1]"), catalog._index(md))


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
    text = catalog.repo_backlog_path().read_text(encoding="utf-8")
    index = catalog._index(text)
    assert {"R4", "#185"} <= set(index)
    assert catalog._index(text) is index  # cached by content
    req = parse_request(BODY.format(block='items: [R4, "#185"]'), index)
    assert req.steps[0].text.startswith("R4")
    assert all(len(s.text) <= catalog.MAX_PROSE_TEXT for s in req.steps)


def test_a_64kb_body_of_unclosed_openers_is_parsed_in_linear_time():
    """L7: the lazy-quantifier fence regex was quadratic on this."""
    body = "```rig-test\n" * (64_000 // len("```rig-test\n"))
    assert len(body) <= catalog.MAX_BODY_CHARS
    t0 = time.perf_counter()
    with pytest.raises(RigRequestError, match="no ```rig-test block"):
        parse_request(body, {})
    assert catalog.peek_rig(body) is None
    nested = "```rig-test\n  \n" * 4000 + "```\n"  # openers, then one closer
    with pytest.raises(RigRequestError):
        parse_request(nested, {})
    assert time.perf_counter() - t0 < 0.5


def test_a_body_over_the_cap_is_an_invalid_request():
    body = BODY.format(block="items: [R4]") + "x" * catalog.MAX_BODY_CHARS
    with pytest.raises(RigRequestError, match="issue body too long"):
        parse_request(body, {})
    assert catalog.peek_rig(body) is None


@pytest.mark.parametrize(
    ("text", "blocks", "rest"),
    [
        ("a\n```rig-test\nx: 1\n```\nb", ["x: 1\n"], "a\nb"),
        ("a\r\n  ```rig-test \r\nx: 1\r\n\t```  \r\nb", ["x: 1\n"], "a\nb"),
        ("```rig-test\n```", [""], ""),
        ("```rig-test\n1\n```\n```rig-test\n2\n```", ["1\n", "2\n"], ""),
        ("```rig-test\nnever closed", [], "```rig-test\nnever closed"),
        (
            "```python\nx\n```\n```rig-test-not\ny\n```",
            [],
            "```python\nx\n```\n```rig-test-not\ny\n```",
        ),
    ],
)
def test_split_fences(text, blocks, rest):
    assert catalog.split_fences(text) == (blocks, rest)


def test_catalog_falls_back_to_the_repo_backlog_when_no_bundled_copy(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "BUNDLED_CATALOG", tmp_path / "missing.md")
    assert "R4" in catalog.catalog_index()
    monkeypatch.setattr(catalog, "repo_backlog_path", lambda: tmp_path / "also-missing.md")
    assert catalog.load_catalog_text() == ""
