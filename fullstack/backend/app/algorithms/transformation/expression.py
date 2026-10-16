"""Safe AST-based formula expression evaluation engine for dynamic variable addition.

Supports arithmetic, unary, power, statistical (zscore, minmax, yeojohnson),
math functions (log, sqrt, exp, etc.), and conditional logic (where, ifelse)
without using eval or exec.
"""
from __future__ import annotations

import ast
from typing import Any, Callable
import numpy as np
import polars as pl

from ...domain.errors import BizError


# This evaluator uses Float64 arithmetic. Integer-domain values must stay below
# this boundary until an explicit floating operation (division/math function).
# Reject rather than silently rounding a source, literal, or intermediate.
_INTEGER_PRECISION_LIMIT = 1 << 53
_INTEGER_DTYPES = (pl.Int8, pl.Int16, pl.Int32, pl.Int64,
                   pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64)


def _integer_precision_error() -> BizError:
    return BizError(
        "EXPRESSION_INTEGER_PRECISION",
        "整数の入力・定数・計算途中の値が安全な計算範囲を超えています。"
        "整数の絶対値を 9007199254740992 未満にしたデータまたは式を使用してください。"
        "値を丸めずに処理を中止しました。",
        status_code=422,
    )


def _guard_integer_values(values: Any) -> None:
    # Integer literals can exceed NumPy's integer types; check them before
    # np.asarray. Input Series are likewise checked before nullable to_numpy
    # can silently promote them to Float64.
    if isinstance(values, (int, np.integer)):
        if abs(int(values)) >= _INTEGER_PRECISION_LIMIT:
            raise _integer_precision_error()
        return
    array = np.asarray(values)
    if array.dtype.kind in "iuf":
        # Compare both signs without abs(signed-min), which can overflow.
        if np.any(array >= _INTEGER_PRECISION_LIMIT) or np.any(array <= -_INTEGER_PRECISION_LIMIT):
            raise _integer_precision_error()
    elif array.dtype.kind == "O":
        for value in array.flat:
            if isinstance(value, (int, float, np.integer, np.floating)):
                _guard_integer_values(value)


def _validate_integer_sources(df: pl.DataFrame, parsed: ast.AST) -> set[str]:
    referenced = {node.id for node in ast.walk(parsed) if isinstance(node, ast.Name)}
    integer_names = {name for name in referenced.intersection(df.columns)
                     if df[name].dtype in (*_INTEGER_DTYPES, pl.Boolean)}
    for name in integer_names:
        series = df[name]
        low, high = series.min(), series.max()
        for value in (low, high):
            if value is not None:
                _guard_integer_values(value)
    return integer_names


def _safe_zscore(arr: np.ndarray) -> np.ndarray:
    # Standardize bounded coordinates so small/large measurement units cannot
    # underflow/overflow the population variance or an absolute cutoff.
    result = _safe_minmax(arr)
    valid = np.isfinite(result)
    observed = result[valid]
    if observed.size and np.any(observed != observed[0]):
        result[valid] = (observed - np.mean(observed)) / np.std(observed)
    return result


def _safe_minmax(arr: np.ndarray) -> np.ndarray:
    values = np.asarray(arr, dtype=np.float64)
    valid = np.isfinite(values)
    result = np.full(values.shape, np.nan, dtype=np.float64)
    observed = values[valid]
    if not observed.size:
        return result
    low, high = np.min(observed), np.max(observed)
    if low == high:
        result[valid] = 0.0
        return result
    with np.errstate(over="ignore"):
        span = high - low
    if np.isfinite(span):
        # Subtract before scaling to retain representable local differences.
        result[valid] = (observed - low) / span
    else:
        # Opposite-sign finite endpoints may have an overflowing range.
        scale = max(abs(low), abs(high))
        lower, upper = low / scale, high / scale
        result[valid] = (observed / scale - lower) / (upper - lower)
    return result


def _safe_log(arr: np.ndarray) -> np.ndarray:
    return np.log(np.maximum(arr, 1e-12))


def _safe_log1p(arr: np.ndarray) -> np.ndarray:
    return np.log1p(np.maximum(arr, -0.999999999999))


def _safe_sqrt(arr: np.ndarray) -> np.ndarray:
    return np.sqrt(np.maximum(arr, 0.0))


def _safe_sigmoid(arr: np.ndarray) -> np.ndarray:
    clipped = np.clip(arr, -50.0, 50.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _safe_yeojohnson(arr: np.ndarray, lmbda: float = 0.5) -> np.ndarray:
    """Yeo-Johnson transformation for both positive and negative values."""
    res = np.zeros_like(arr, dtype=np.float64)
    pos_mask = arr >= 0
    neg_mask = ~pos_mask

    if abs(lmbda) > 1e-6:
        res[pos_mask] = ((arr[pos_mask] + 1.0) ** lmbda - 1.0) / lmbda
    else:
        res[pos_mask] = np.log(arr[pos_mask] + 1.0)

    if abs(lmbda - 2.0) > 1e-6:
        res[neg_mask] = -((-arr[neg_mask] + 1.0) ** (2.0 - lmbda) - 1.0) / (2.0 - lmbda)
    else:
        res[neg_mask] = -np.log(-arr[neg_mask] + 1.0)

    return res


def _safe_where(cond: Any, a: Any, b: Any) -> np.ndarray:
    left_arr, right_arr = np.asarray(a), np.asarray(b)
    if left_arr.dtype.kind in "biuf" and right_arr.dtype.kind in "biuf":
        return np.where(cond, left_arr, right_arr)

    # NumPy otherwise coerces numeric NaN/None to literal text when the other
    # branch contains strings. Select actual values before choosing a dtype.
    result = np.where(cond, left_arr.astype(object), right_arr.astype(object))
    observed = [v for v in result.flat if v is not None]
    numeric = (int, float, np.integer, np.floating)
    has_number = any(isinstance(v, numeric) and not isinstance(v, (bool, np.bool_))
                     for v in observed)
    if ((has_number and all(isinstance(v, (*numeric, bool, np.bool_)) for v in observed))
            or (not observed and (left_arr.dtype.kind in "iuf" or right_arr.dtype.kind in "iuf"))):
        # Keep nullable numeric selections usable by subsequent NumPy ufuncs.
        return result.astype(np.float64)
    return result


def _result_series(name: str, values: np.ndarray) -> pl.Series:
    if values.dtype == bool:
        return pl.Series(name, values, dtype=pl.Boolean)
    if np.issubdtype(values.dtype, np.integer):
        return pl.Series(name, values, dtype=pl.Int64)
    if np.issubdtype(values.dtype, np.floating):
        finite_values = np.where(np.isfinite(values), values, np.nan)
        return pl.Series(name, finite_values, dtype=pl.Float64, nan_to_null=True)

    # Preserve true nulls and actual nonfinite numeric results, while retaining
    # literal strings such as "None" and "NaN" as ordinary observations.
    cleaned = [None if v is None or (isinstance(v, (float, np.floating))
                                    and not np.isfinite(v)) else v for v in values]
    observed = [v for v in cleaned if v is not None]
    if observed and all(isinstance(v, (bool, np.bool_)) for v in observed):
        return pl.Series(name, cleaned, dtype=pl.Boolean)
    if observed and all(isinstance(v, (int, np.integer)) for v in observed):
        return pl.Series(name, cleaned, dtype=pl.Int64)
    if observed and all(isinstance(v, (int, float, np.integer, np.floating)) for v in observed):
        return pl.Series(name, cleaned, dtype=pl.Float64)
    return pl.Series(name, [None if v is None else str(v) for v in cleaned], dtype=pl.String)


# Whitelisted function library
FUNCTIONS: dict[str, Callable[..., Any]] = {
    "abs": np.abs,
    "sin": np.sin,
    "cos": np.cos,
    "tan": np.tan,
    "tanh": np.tanh,
    "exp": np.exp,
    "sqrt": _safe_sqrt,
    "log": _safe_log,
    "log10": lambda a: np.log10(np.maximum(a, 1e-12)),
    "log1p": _safe_log1p,
    "round": lambda a, n=0: np.round(a, n),
    "clip": lambda a, lo, hi: np.clip(a, lo, hi),
    "sigmoid": _safe_sigmoid,
    "zscore": _safe_zscore,
    "minmax": _safe_minmax,
    "yeojohnson": _safe_yeojohnson,
    "where": _safe_where,
    "ifelse": _safe_where,
}


class SafeEvaluator(ast.NodeVisitor):
    def __init__(self, variables: dict[str, np.ndarray], integer_names: set[str] | None = None):
        self.variables = variables
        self.integer_names = integer_names or set()
        self.integer_nodes: dict[int, bool] = {}
        self.floating_power_nodes: set[int] = set()

    def _integer_domain(self, node: ast.AST) -> bool:
        def integer(child: ast.AST) -> bool:
            return self.integer_nodes.get(id(child), False)

        def nullable_integer(child: ast.AST) -> bool:
            return integer(child) or isinstance(child, ast.Constant) and child.value is None

        if isinstance(node, ast.Name):
            return node.id in self.integer_names
        if isinstance(node, ast.Constant):
            return isinstance(node.value, int)
        if isinstance(node, (ast.Compare, ast.BoolOp)):
            return True  # Boolean results are exact 0/1 in numeric expressions.
        if isinstance(node, ast.Expression):
            return integer(node.body)
        if isinstance(node, ast.UnaryOp):
            return isinstance(node.op, ast.Not) or integer(node.operand) and isinstance(node.op, (ast.UAdd, ast.USub, ast.Invert))
        if isinstance(node, ast.BinOp):
            if isinstance(node.op, (ast.BitAnd, ast.BitOr)):
                return True  # Evaluated as logical_and/logical_or, hence 0/1.
            return (integer(node.left) and integer(node.right)
                    and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod, ast.Pow))
                    and id(node) not in self.floating_power_nodes)
        if isinstance(node, ast.IfExp):
            return nullable_integer(node.body) and nullable_integer(node.orelse)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            args = list(node.args)
            keywords = {kw.arg: kw.value for kw in node.keywords}
            if node.func.id in ("where", "ifelse"):
                left = args[1] if len(args) > 1 else keywords.get("a")
                right = args[2] if len(args) > 2 else keywords.get("b")
                return left is not None and right is not None and nullable_integer(left) and nullable_integer(right)
            if node.func.id == "clip":
                operands = [args[index] if len(args) > index else keywords.get(name)
                            for index, name in enumerate(("a", "lo", "hi"))]
                return all(value is not None and integer(value) for value in operands)
            if node.func.id in ("abs", "round"):
                first = args[0] if args else keywords.get("a")
                return first is not None and integer(first)
        # True division, mixed floating operands and transcendental/statistical
        # functions have the established floating-point precision contract.
        return False

    def visit(self, node: ast.AST) -> Any:
        method = getattr(self, f"visit_{node.__class__.__name__}", None)
        if method is None:
            raise BizError(
                "EXPRESSION_UNSUPPORTED_SYNTAX",
                f"数式内に未サポートの構文 '{node.__class__.__name__}' が含まれています。",
            )
        result = method(node)
        integer_domain = self._integer_domain(node)
        self.integer_nodes[id(node)] = integer_domain
        if integer_domain:
            _guard_integer_values(result)
        return result

    def visit_Expression(self, node: ast.Expression) -> Any:
        return self.visit(node.body)

    def visit_Constant(self, node: ast.Constant) -> Any:
        return node.value

    def visit_Name(self, node: ast.Name) -> Any:
        name = node.id
        if name in self.variables:
            return self.variables[name]
        if name in FUNCTIONS:
            return FUNCTIONS[name]
        if name.lower() == "pi":
            return np.pi
        if name.lower() == "e":
            return np.e
        raise BizError("EXPRESSION_UNKNOWN_VARIABLE", f"変数または列 '{name}' が見つかりません。")

    def visit_UnaryOp(self, node: ast.UnaryOp) -> Any:
        operand = self.visit(node.operand)
        if isinstance(node.op, ast.UAdd):
            return +operand
        elif isinstance(node.op, ast.USub):
            return -operand
        elif isinstance(node.op, ast.Not):
            return np.logical_not(operand)
        elif isinstance(node.op, ast.Invert):
            return ~operand
        raise BizError("EXPRESSION_UNSUPPORTED_OP", f"未対応の単項演算子: {node.op.__class__.__name__}")

    def visit_BinOp(self, node: ast.BinOp) -> Any:
        left = self.visit(node.left)
        right = self.visit(node.right)
        op = node.op
        integer_operands = (self.integer_nodes.get(id(node.left), False)
                            and self.integer_nodes.get(id(node.right), False))
        if integer_operands and not isinstance(op, (ast.BitAnd, ast.BitOr)):
            # Helpers such as abs/round/where may return fixed-width NumPy ints.
            # Promote those *before* arithmetic can wrap; every operand has
            # already passed the exact (<2**53) integer-value guard. Python
            # integers retain their arbitrary-precision arithmetic.
            def promote(value: Any) -> Any:
                if isinstance(value, np.ndarray) and value.dtype.kind in "biu":
                    return value.astype(np.float64)
                if isinstance(value, (np.integer, np.bool_)):
                    return float(value)
                return value
            left, right = promote(left), promote(right)
        if isinstance(op, ast.Add):
            return left + right
        elif isinstance(op, ast.Sub):
            return left - right
        elif isinstance(op, ast.Mult):
            return left * right
        elif isinstance(op, ast.Div):
            # Avoid division by zero error by replacing 0 with nan
            with np.errstate(divide="ignore", invalid="ignore"):
                return left / right
        elif isinstance(op, ast.FloorDiv):
            with np.errstate(divide="ignore", invalid="ignore"):
                return left // right
        elif isinstance(op, ast.Mod):
            with np.errstate(divide="ignore", invalid="ignore"):
                return left % right
        elif isinstance(op, ast.Pow):
            with np.errstate(all="ignore"):
                result = left ** right
            if integer_operands and np.any(np.asarray(right) < 0):
                # A negative exponent explicitly enters floating arithmetic.
                # Still guard nonnegative-exponent rows in a mixed array before
                # that transition can hide their integer-domain overflow.
                self.floating_power_nodes.add(id(node))
                values, exponents = np.broadcast_arrays(result, right)
                _guard_integer_values(values[exponents >= 0])
            return result
        elif isinstance(op, ast.BitAnd):
            return np.logical_and(left, right)
        elif isinstance(op, ast.BitOr):
            return np.logical_or(left, right)
        raise BizError("EXPRESSION_UNSUPPORTED_OP", f"未対応の2項演算子: {op.__class__.__name__}")

    def visit_Compare(self, node: ast.Compare) -> Any:
        left = self.visit(node.left)
        result = None
        current_left = left
        for op, comparator in zip(node.ops, node.comparators):
            right = self.visit(comparator)
            if isinstance(op, ast.Eq):
                cmp_res = current_left == right
            elif isinstance(op, ast.NotEq):
                cmp_res = current_left != right
            elif isinstance(op, ast.Lt):
                cmp_res = current_left < right
            elif isinstance(op, ast.LtE):
                cmp_res = current_left <= right
            elif isinstance(op, ast.Gt):
                cmp_res = current_left > right
            elif isinstance(op, ast.GtE):
                cmp_res = current_left >= right
            else:
                raise BizError("EXPRESSION_UNSUPPORTED_OP", f"未対応の比較演算子: {op.__class__.__name__}")
            result = cmp_res if result is None else np.logical_and(result, cmp_res)
            current_left = right
        return result

    def visit_BoolOp(self, node: ast.BoolOp) -> Any:
        values = [self.visit(val) for val in node.values]
        if isinstance(node.op, ast.And):
            res = values[0]
            for v in values[1:]:
                res = np.logical_and(res, v)
            return res
        elif isinstance(node.op, ast.Or):
            res = values[0]
            for v in values[1:]:
                res = np.logical_or(res, v)
            return res
        raise BizError("EXPRESSION_UNSUPPORTED_OP", f"未対応の論理演算子: {node.op.__class__.__name__}")

    def visit_IfExp(self, node: ast.IfExp) -> Any:
        test = self.visit(node.test)
        body = self.visit(node.body)
        orelse = self.visit(node.orelse)
        return _safe_where(test, body, orelse)

    def visit_Call(self, node: ast.Call) -> Any:
        func = self.visit(node.func)
        if not callable(func):
            raise BizError("EXPRESSION_NOT_CALLABLE", f"'{node.func}' は呼び出し可能な関数ではありません。")
        args = [self.visit(arg) for arg in node.args]
        kwargs = {kw.arg: self.visit(kw.value) for kw in node.keywords if kw.arg}
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            raise BizError("EXPRESSION_EXEC_ERROR", f"関数実行中にエラーが発生しました: {exc}") from exc


def evaluate_expression(
    df: pl.DataFrame,
    expression: str,
    new_column_name: str,
) -> tuple[pl.DataFrame, pl.Series, dict[str, Any]]:
    """Evaluate an expression against a DataFrame and return updated DataFrame and metadata."""
    if not new_column_name or not new_column_name.strip():
        raise BizError("EXPRESSION_INVALID_NAME", "新規列名を指定してください。")
    new_col = new_column_name.strip()
    if new_col == "__rowId__":
        raise BizError("EXPRESSION_INVALID_NAME", "'__rowId__' を列名にすることはできません。")

    clean_expr = expression.strip()
    if not clean_expr:
        raise BizError("EXPRESSION_EMPTY", "数式が入力されていません。")

    try:
        parsed = ast.parse(clean_expr, mode="eval")
    except SyntaxError as exc:
        raise BizError("EXPRESSION_SYNTAX_ERROR", f"数式の構文エラーです (行 {exc.lineno}, 列 {exc.offset}): {exc.msg}") from exc

    integer_names = _validate_integer_sources(df, parsed)

    # Prepare variable bindings
    n_rows = df.height
    var_map: dict[str, np.ndarray] = {}
    for col in df.columns:
        if col == "__rowId__":
            continue
        series = df[col]
        if series.dtype == pl.Null:
            var_map[col] = np.full(n_rows, np.nan)
        elif series.dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
            var_map[col] = series.to_numpy().astype(np.float64)
        else:
            var_map[col] = np.array(series.to_list())

    evaluator = SafeEvaluator(var_map, integer_names)
    raw_res = evaluator.visit(parsed)

    # Convert scalar or array result to Polars Series
    arr_res = np.asarray(raw_res)
    if arr_res.ndim == 0:
        arr_res = np.full(n_rows, arr_res.item())
    else:
        if len(arr_res) != n_rows:
            raise BizError(
                "EXPRESSION_LENGTH_MISMATCH",
                f"計算結果の行数 ({len(arr_res)}) がデータセットの行数 ({n_rows}) と一致しません。",
            )

    new_series = _result_series(new_col, arr_res)

    # Reconstruct dataframe with new or replaced column
    existing_cols = [c for c in df.columns if c != new_col]
    updated_df = df.select(existing_cols).with_columns(new_series)

    # Compute summary stats
    non_null = new_series.drop_nulls()
    stats: dict[str, Any] = {
        "count": len(non_null),
        "nullCount": new_series.null_count(),
    }
    if new_series.dtype in (pl.Float64, pl.Int64) and len(non_null) > 0:
        f_arr = non_null.to_numpy().astype(np.float64)
        finite = f_arr[np.isfinite(f_arr)]
        if len(finite) > 0:
            stats.update({
                "min": round(float(np.min(finite)), 4),
                "max": round(float(np.max(finite)), 4),
                "mean": round(float(np.mean(finite)), 4),
                "std": round(float(np.std(finite)), 4),
            })

    meta = {
        "column": new_col,
        "expression": clean_expr,
        "dtype": str(new_series.dtype),
        "stats": stats,
    }
    return updated_df, new_series, meta


def preview_expression(
    df: pl.DataFrame,
    expression: str,
    new_column_name: str = "new_var",
) -> dict[str, Any]:
    """Safely validate and preview expression evaluation without modifying dataset."""
    try:
        # Validate the complete integer inputs even though the displayed preview
        # evaluates only its documented first-100-row sample.
        try:
            parsed = ast.parse(expression.strip(), mode="eval")
        except SyntaxError:
            parsed = None  # evaluate_expression supplies the standard error.
        if parsed is not None:
            _validate_integer_sources(df, parsed)
        sample_df = df.head(min(100, df.height))
        _, series, meta = evaluate_expression(sample_df, expression, new_column_name)

        preview_vals = [
            round(float(v), 4) if isinstance(v, (float, np.floating)) and np.isfinite(v)
            else (None if v is None or (isinstance(v, float) and np.isnan(v)) else str(v))
            for v in series.head(10).to_list()
        ]

        histogram = []
        if series.dtype in (pl.Float64, pl.Int64):
            arr = series.to_numpy().astype(np.float64)
            finite = arr[np.isfinite(arr)]
            if len(finite) > 1:
                bins = np.linspace(np.min(finite), np.max(finite), 11)
                counts, _ = np.histogram(finite, bins=bins)
                for i in range(len(counts)):
                    histogram.append({
                        "bin": f"{bins[i]:.2f} - {bins[i+1]:.2f}",
                        "count": int(counts[i]),
                    })

        return {
            "valid": True,
            "error": None,
            "column": new_column_name,
            "previewValues": preview_vals,
            "stats": meta["stats"],
            "histogram": histogram,
        }
    except BizError as err:
        return {
            "valid": False,
            "error": err.message,
            "column": new_column_name,
            "previewValues": [],
            "stats": {},
            "histogram": [],
        }
    except Exception as exc:
        return {
            "valid": False,
            "error": str(exc),
            "column": new_column_name,
            "previewValues": [],
            "stats": {},
            "histogram": [],
        }
