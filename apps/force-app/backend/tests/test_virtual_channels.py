"""Safe formula evaluator for virtual channels (app/virtual_channels.py).

The formula string is operator-authored, saved to nidaq_channels.json, and re-evaluated on every
acquisition chunk — it must never be eval()'d. These tests exercise both what the evaluator
accepts (real arithmetic on real chunk-shaped arrays) and what it must refuse.
"""

import numpy as np
import pytest

from app.config import DYNO_CHANNELS, ExtraChannel
from app.virtual_channels import (
    FormulaError,
    compute_extra_columns,
    evaluate,
    parse_formula,
    referenced_channels,
)


def _chunk(n=8):
    return np.arange(n, dtype=np.float64)


class TestAcceptedExpressions:
    def test_simple_sum(self):
        fx, fy = _chunk(), _chunk() * 2
        out = evaluate("Fx + Fy", {"Fx": fx, "Fy": fy})
        assert np.allclose(out, fx + fy)

    def test_arithmetic_precedence_and_parens(self):
        a, b, c = _chunk(), _chunk() + 1, _chunk() + 2
        out = evaluate("(A + B) * C - A / 2", {"A": a, "B": b, "C": c})
        assert np.allclose(out, (a + b) * c - a / 2)

    def test_unary_minus(self):
        fx = _chunk() + 1
        assert np.allclose(evaluate("-Fx", {"Fx": fx}), -fx)

    def test_numeric_literals(self):
        fx = _chunk()
        assert np.allclose(evaluate("Fx * 2.5 + 1", {"Fx": fx}), fx * 2.5 + 1)

    def test_allowed_functions(self):
        fx = _chunk() - 4  # crosses zero, exercises abs()
        assert np.allclose(evaluate("abs(Fx)", {"Fx": fx}), np.abs(fx))
        fy = _chunk() + 1
        assert np.allclose(evaluate("sqrt(Fy)", {"Fy": fy}), np.sqrt(fy))
        assert np.allclose(evaluate("min(Fx, Fy)", {"Fx": fx, "Fy": fy}), np.minimum(fx, fy))
        assert np.allclose(evaluate("max(Fx, Fy)", {"Fx": fx, "Fy": fy}), np.maximum(fx, fy))

    def test_resultant_force_magnitude(self):
        """The kind of formula this feature exists for: sqrt(Fx^2 + Fy^2) via repeated
        multiplication, since ** (power) is deliberately not in the whitelist (see below)."""
        fx, fy = _chunk() + 1, _chunk() + 2
        out = evaluate("sqrt(Fx * Fx + Fy * Fy)", {"Fx": fx, "Fy": fy})
        assert np.allclose(out, np.sqrt(fx**2 + fy**2))


class TestReferencedChannels:
    def test_collects_every_name_used(self):
        assert referenced_channels("Fx + Fy - Tacho") == {"Fx", "Fy", "Tacho"}

    def test_does_not_treat_function_names_as_channels(self):
        assert referenced_channels("abs(Fx)") == {"Fx"}

    def test_empty_for_a_pure_constant(self):
        assert referenced_channels("1 + 2") == set()


class TestRejectedExpressions:
    """Anything outside plain arithmetic must be refused at parse time — this is the actual
    security boundary (no eval(), no arbitrary code execution from a saved formula string)."""

    @pytest.mark.parametrize(
        "expr",
        [
            "__import__('os').system('echo hi')",
            "().__class__",
            "[x for x in range(10)]",
            "Fx if Fy else Fz",
            "lambda x: x",
            "Fx.bit_length()",  # attribute access
            "Fx[0]",  # subscripting
            "open('x')",
            "exec('1')",
            "Fx ** 2",  # ** deliberately not whitelisted (see test_resultant_force_magnitude)
            "Fx or Fy",
            "Fx == Fy",
            "1; 2",  # not a valid single `eval`-mode expression at all
        ],
    )
    def test_refuses_anything_outside_plain_arithmetic(self, expr):
        with pytest.raises(FormulaError):
            parse_formula(expr)

    def test_refuses_an_unwhitelisted_function(self):
        with pytest.raises(FormulaError):
            parse_formula("eval(Fx)")

    def test_refuses_keyword_arguments(self):
        with pytest.raises(FormulaError):
            parse_formula("max(Fx, Fy, key=abs)")

    def test_refuses_syntactically_invalid_input(self):
        with pytest.raises(FormulaError):
            parse_formula("Fx + ")

    def test_refuses_non_numeric_constants(self):
        with pytest.raises(FormulaError):
            parse_formula("Fx + 'oops'")

    def test_evaluate_raises_on_an_unknown_channel_name(self):
        """A formula can reference a channel that existed when it was saved but was later removed
        or renamed — must fail clearly at evaluation, not silently produce garbage or KeyError."""
        with pytest.raises(FormulaError):
            evaluate("Fx + Ghost", {"Fx": _chunk()})


def _dyno(n=8, k=8):
    """(n, 8) dyno columns — column i holds the constant value i+1, so a formula referencing
    DYNO_CHANNELS[i] has an unambiguous expected value."""
    return np.tile(np.arange(1, k + 1, dtype=np.float64), (n, 1))


class TestComputeExtraColumns:
    """The shared logic session.py (live, per chunk) and finalize.py (archived, whole capture)
    both call — column order and what a formula can reference must never drift between them."""

    def test_no_extra_channels_returns_a_correctly_shaped_empty_array(self):
        out = compute_extra_columns([], _dyno(5), np.zeros(5), {"Fx": np.zeros(5)})
        assert out.shape == (5, 0)

    def test_virtual_channel_reads_dyno_tacho_and_summed_axes(self):
        n = 4
        dyno = _dyno(n)  # Fx1=1, Fx2=2, ... Fz4=8
        tacho = np.full(n, 100.0)
        axes = {"Fx": np.full(n, 3.0), "Fy": np.full(n, 5.0), "Fz": np.full(n, 7.0)}
        extras = [
            ExtraChannel(name="V1", source="virtual", formula="Fx1 + Fz4"),  # 1 + 8
            ExtraChannel(name="V2", source="virtual", formula="Fx + Tacho"),  # 3 + 100
        ]
        out = compute_extra_columns(extras, dyno, tacho, axes)
        assert out.shape == (n, 2)
        assert np.allclose(out[:, 0], 9.0)
        assert np.allclose(out[:, 1], 103.0)

    def test_hardware_channel_is_a_straight_passthrough(self):
        n = 3
        hw = np.full((n, 1), 42.0)
        extras = [ExtraChannel(name="Temp", source="hardware", physical="x")]
        out = compute_extra_columns(extras, _dyno(n), np.zeros(n), {"Fx": np.zeros(n)}, hw)
        assert np.allclose(out[:, 0], 42.0)

    def test_a_virtual_channel_can_reference_an_earlier_hardware_extra(self):
        n = 3
        hw = np.full((n, 1), 10.0)
        extras = [
            ExtraChannel(name="Temp", source="hardware", physical="x"),
            ExtraChannel(name="Doubled", source="virtual", formula="Temp * 2"),
        ]
        out = compute_extra_columns(extras, _dyno(n), np.zeros(n), {"Fx": np.zeros(n)}, hw)
        assert np.allclose(out[:, 0], 10.0)
        assert np.allclose(out[:, 1], 20.0)

    def test_output_column_order_matches_extra_channels_order_not_source_grouping(self):
        n = 2
        hw = np.full((n, 1), 5.0)
        extras = [
            ExtraChannel(name="V", source="virtual", formula="1 + 1"),
            ExtraChannel(name="H", source="hardware", physical="x"),
        ]
        out = compute_extra_columns(extras, _dyno(n), np.zeros(n), {"Fx": np.zeros(n)}, hw)
        assert np.allclose(out[:, 0], 2.0)  # V, first in the list
        assert np.allclose(out[:, 1], 5.0)  # H, second

    def test_a_broken_formula_zeros_its_column_and_calls_on_error_instead_of_raising(self):
        """The one thing this must never do is take a whole recording down because one virtual
        channel's formula references something that no longer exists."""
        n = 3
        extras = [ExtraChannel(name="Bad", source="virtual", formula="Ghost + 1")]
        errors = []
        out = compute_extra_columns(
            extras,
            _dyno(n),
            np.zeros(n),
            {"Fx": np.zeros(n)},
            on_error=lambda name, e: errors.append(name),
        )
        assert np.allclose(out[:, 0], 0.0)
        assert errors == ["Bad"]

    def test_dyno_names_match_the_real_config_order(self):
        """Locks in the assumption every caller relies on: column i of the `dyno` argument is
        DYNO_CHANNELS[i], not some other ordering."""
        assert DYNO_CHANNELS == ["Fx1", "Fx2", "Fy1", "Fy2", "Fz1", "Fz2", "Fz3", "Fz4"]


class TestFormulasThatUsedToPassValidationThenCrashed:
    """Review 1.2: wrong arity and constant division by zero were accepted at save time and then
    raised TypeError / ZeroDivisionError on the consumer thread, finalize and recovery."""

    @pytest.mark.parametrize(
        "formula",
        ["min(Fx)", "max(Fx)", "min(Fx, Fy, Fz)", "sqrt()", "sqrt(Fx, Fy)", "abs()", "abs(1, 2)"],
    )
    def test_wrong_arity_is_rejected_at_parse_time(self, formula):
        with pytest.raises(FormulaError, match="argument"):
            parse_formula(formula)
        with pytest.raises(FormulaError):
            referenced_channels(formula)

    @pytest.mark.parametrize("formula", ["1/0", "Fx/0", "Fx/(1-1)", "Fx/(2*0.0)", "1/-0"])
    def test_constant_division_by_zero_is_rejected(self, formula):
        with pytest.raises(FormulaError, match="zero"):
            parse_formula(formula)

    def test_division_by_a_channel_or_nonzero_constant_is_still_fine(self):
        assert referenced_channels("Fx/Fy") == {"Fx", "Fy"}
        assert referenced_channels("Fx/2") == {"Fx"}
        assert referenced_channels("min(Fx, 0)/(1+1)") == {"Fx"}

    def test_evaluate_wraps_any_exception_in_formula_error(self, monkeypatch):
        import app.virtual_channels as vc

        def _boom(*a):
            raise TypeError("surprise")

        monkeypatch.setitem(vc._FUNCS, "sqrt", _boom)
        with pytest.raises(FormulaError, match="surprise"):
            evaluate("sqrt(Fx)", {"Fx": _chunk()})

    def test_compute_extra_columns_degrades_instead_of_raising(self, monkeypatch):
        import app.virtual_channels as vc

        n = 3
        # Bypass the save-time check (a hand-edited nidaq_channels.json / an old manifest can
        # still carry these): the live path must zero the column, never raise.
        monkeypatch.setattr(vc, "_validate", lambda node: set())
        extras = [
            ExtraChannel(name="A", source="virtual", formula="min(Fx)"),
            ExtraChannel(name="B", source="virtual", formula="1/0"),
            ExtraChannel(name="C", source="virtual", formula="sqrt()"),
        ]
        errors = []
        out = compute_extra_columns(
            extras,
            np.zeros((n, 8)),
            np.zeros(n),
            {"Fx": np.zeros(n)},
            on_error=lambda name, e: errors.append(name),
        )
        assert np.allclose(out, 0.0)
        assert errors == ["A", "B", "C"]
