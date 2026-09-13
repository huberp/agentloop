from __future__ import annotations

import ast
import math
import operator
from collections.abc import Callable
from typing import cast

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.errors import ToolExecutionError
from agentloop.tools.registry import tool_def

_ALLOWED_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.FloorDiv: operator.floordiv,
}
_ALLOWED_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_ALLOWED_FUNCTIONS: dict[str, Callable[..., float]] = {
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log,
}
_ALLOWED_CONSTANTS: dict[str, float] = {"pi": math.pi, "e": math.e}


class CalculateInput(BaseModel):
    expression: str


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
        bin_op = _ALLOWED_BINOPS[type(node.op)]
        return float(bin_op(_eval(node.left), _eval(node.right)))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARY:
        unary_op = cast(Callable[[float], float], _ALLOWED_UNARY[type(node.op)])
        return float(unary_op(_eval(node.operand)))
    if isinstance(node, ast.Name) and node.id in _ALLOWED_CONSTANTS:
        return _ALLOWED_CONSTANTS[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _ALLOWED_FUNCTIONS:
        fn = _ALLOWED_FUNCTIONS[node.func.id]
        return float(fn(*[_eval(arg) for arg in node.args]))
    raise ToolExecutionError("Unsupported expression")


@tool_def(name="calculate", description="Safely evaluate a mathematical expression", permissions="safe")
async def calculate(ctx: RunContext[AgentDeps], args: CalculateInput) -> str:
    del ctx
    tree = ast.parse(args.expression, mode="eval")
    value = _eval(tree)
    return str(int(value)) if value.is_integer() else str(value)
