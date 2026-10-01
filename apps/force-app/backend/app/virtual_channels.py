"""Safe evaluation of operator-authored virtual-channel formulas.

A formula (e.g. "sqrt(Fx*Fx + Fy*Fy)") is saved to nidaq_channels.json and re-evaluated on every
acquisition chunk during a real recording — this is NOT a place for eval()/exec(): a saved string
being fed straight to Python's interpreter is exactly the kind of arbitrary-code-execution risk
that matters even in a single-operator desktop app, since the file is plain JSON an operator (or a
future import/sync feature) could hand-edit or copy from elsewhere.

Instead this parses the expression with the standard library's `ast` module and walks the tree,
allowing only a small, explicit whitelist of node types: arithmetic (+ - * /, unary -), a short list
of elementwise-safe functions, references to other channels by name, and numeric literals.
Deliberately excluded: attribute/subscript access, comparisons, boolean/conditional logic, function
calls outside the whitelist, and `**` (power) — `sqrt(x*x + y*y)` covers the motivating case
(resultant force magnitude) without needing it. Evaluation is vectorized: each channel reference
resolves to a whole chunk's numpy array, so the formula runs once per chunk, not once per sample.
"""

from __future__ import annotations

import ast
import logging
from collections.abc import Callable

import numpy as np

from .config import DYNO_CHANNELS, TACHO_CHANNEL, ExtraChannel

log = logging.getLogger("force_app.virtual_channels")

_BINOPS: dict[type, object] = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
}
_UNARY: dict[type, object] = {
    ast.USub: lambda a: -a,
    ast.UAdd: lambda a: a,
}
_FUNCS: dict[str, object] = {
    "abs": np.abs,
    "sqrt": np.sqrt,
    "min": np.minimum,
    "max": np.maximum,
}


class FormulaError(ValueError):
    """A formula is malformed, uses something outside the whitelist, or references an unknown
    channel. Always carries a message safe to show directly in the equation-builder UI."""


def parse_formula(expr: str) -> ast.expr:
    """Parse and validate `expr`, returning the AST root. Raises FormulaError for anything that
    isn't plain arithmetic over named channels — never returns something unsafe to evaluate."""
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise FormulaError(f"invalid syntax: {e.msg}") from e
    _validate(tree.body)
    return tree.body


def referenced_channels(expr: str) -> set[str]:
    """Every channel name a (valid) formula reads — used to validate a virtual channel's formula
    only references channels that actually exist, and to build its evaluation namespace."""
    return _validate(parse_formula(expr))


def evaluate(expr: str, values: dict[str, np.ndarray]) -> np.ndarray:
    """Evaluate `expr` against `values` (channel name -> one chunk's worth of samples). Re-parses
    and re-validates every call — this runs per acquisition chunk, but the formula is a handful of
    tokens and chunks are already the unit of work throughout this pipeline, so the parse cost is
    negligible next to the numpy work it guards; keeping validation un-cached also means a formula
    can never be evaluated without being freshly checked against the whitelist."""
    return _eval(parse_formula(expr), values)


def _validate(node: ast.expr) -> set[str]:
    """Recursively confirm every node is in the whitelist; return the channel names referenced."""
    if isinstance(node, ast.BinOp):
        if type(node.op) not in _BINOPS:
            raise FormulaError(f"operator '{type(node.op).__name__}' is not allowed")
        return _validate(node.left) | _validate(node.right)
    if isinstance(node, ast.UnaryOp):
        if type(node.op) not in _UNARY:
            raise FormulaError(f"unary operator '{type(node.op).__name__}' is not allowed")
        return _validate(node.operand)
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise FormulaError("only abs(), sqrt(), min(), max() may be called")
        if node.keywords:
            raise FormulaError("keyword arguments are not allowed")
        names: set[str] = set()
        for arg in node.args:
            names |= _validate(arg)
        return names
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, int | float) or isinstance(node.value, bool):
            raise FormulaError("only numeric constants are allowed")
        return set()
    raise FormulaError(f"'{type(node).__name__}' is not allowed in a channel formula")


def _eval(node: ast.expr, values: dict[str, np.ndarray]):
    if isinstance(node, ast.BinOp):
        return _BINOPS[type(node.op)](_eval(node.left, values), _eval(node.right, values))
    if isinstance(node, ast.UnaryOp):
        return _UNARY[type(node.op)](_eval(node.operand, values))
    if isinstance(node, ast.Call):
        args = [_eval(a, values) for a in node.args]
        return _FUNCS[node.func.id](*args)  # type: ignore[union-attr]
    if isinstance(node, ast.Name):
        if node.id not in values:
            raise FormulaError(f"unknown channel '{node.id}'")
        return values[node.id]
    if isinstance(node, ast.Constant):
        return node.value
    raise FormulaError(
        f"'{type(node).__name__}' is not allowed in a channel formula"
    )  # pragma: no cover


def compute_extra_columns(
    extra_channels: list[ExtraChannel],
    dyno: np.ndarray,
    tacho: np.ndarray,
    axes: dict[str, np.ndarray],
    hw_extra_raw: np.ndarray | None = None,
    on_error: Callable[[str, FormulaError], None] | None = None,
) -> np.ndarray:
    """This chunk/capture's value for every extra (Aux/virtual) channel, in `extra_channels` order.
    Shared between session.py (live, per acquisition chunk) and finalize.py (archived, the whole
    capture at once) so the two can never quietly disagree about column order or what a formula is
    allowed to reference.

    `dyno` is (n, 8) in DYNO_CHANNELS order (Fx1..Fz4), `tacho` is (n,), `axes` has 'Fx'/'Fy'/'Fz'.
    `hw_extra_raw` is (n, H) — H being however many `source="hardware"` entries are in
    `extra_channels` — already-acquired columns in the SAME relative order those entries appear in
    `extra_channels` (this is also the order NidaqSource.channels appends them in, via
    chan.to_extra_channels(), so a caller slicing raw acquisition data need only preserve order, not
    re-derive it). None (or too few) hardware columns supplied is only valid when there are no
    hardware entries to fill — a live chunk from a source with no extra hardware channels configured
    passes hw_extra_raw=None.

    A virtual channel may reference the 8 dyno names, Tacho, Fx/Fy/Fz, and any hardware extra
    EARLIER in the same list — never another virtual channel (no dependency ordering/cycle
    detection is implemented; formulas are flat by design). A formula that fails to evaluate
    (references something unavailable, e.g. one added after this formula was saved and later
    removed) does not take the recording down: `on_error` is called if given, and the column is
    zeroed for that chunk.
    """
    n = dyno.shape[0]
    if not extra_channels:
        return np.empty((n, 0), dtype=np.float64)
    namespace: dict[str, np.ndarray] = dict(zip(DYNO_CHANNELS, (dyno[:, i] for i in range(8))))
    namespace[TACHO_CHANNEL] = tacho
    namespace.update(axes)
    out = np.empty((n, len(extra_channels)), dtype=np.float64)
    hw_idx = 0
    for j, ec in enumerate(extra_channels):
        if ec.source == "hardware":
            col = hw_extra_raw[:, hw_idx] if hw_extra_raw is not None else np.zeros(n)
            out[:, j] = col
            namespace[ec.name] = col
            hw_idx += 1
        else:
            try:
                out[:, j] = evaluate(ec.formula or "", namespace)
            except FormulaError as e:
                if on_error:
                    on_error(ec.name, e)
                else:
                    log.warning("virtual channel '%s' evaluation failed: %s", ec.name, e)
                out[:, j] = 0.0
    return out
