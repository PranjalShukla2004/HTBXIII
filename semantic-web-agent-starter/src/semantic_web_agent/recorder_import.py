"""Convert a simple Playwright Python codegen script into semantic workflow steps.

This module reads source with ast; it NEVER runs recorded code. It intentionally supports
only the most common codegen locator/action patterns in the MVP.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any


SUPPORTED_ACTIONS = {"fill", "click", "check", "uncheck", "select_option"}


def _literal(node: ast.AST | None) -> Any:
    if node is None:
        return None
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        # Regex patterns in generated codegen scripts are a common exception.
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "compile" and node.args:
                return _literal(node.args[0])
        return None


def _locator_details(node: ast.AST) -> dict[str, str] | None:
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
        return None

    method = node.func.attr
    args = [_literal(a) for a in node.args]
    kwargs = {k.arg: _literal(k.value) for k in node.keywords if k.arg}

    if method == "get_by_role":
        role = args[0] if args else None
        label = kwargs.get("name")
        if isinstance(role, str) and isinstance(label, str) and label.strip():
            return {"role": role, "label": label}
    if method in {"get_by_label", "get_by_placeholder", "get_by_text"}:
        label = args[0] if args else None
        if isinstance(label, str) and label.strip():
            role = "text" if method == "get_by_text" else "textbox"
            return {"role": role, "label": label}
    return None


def import_codegen(path: str | Path) -> dict[str, Any]:
    source_path = Path(path)
    tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    calls = sorted(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        ),
        key=lambda c: (c.lineno, c.col_offset),
    )
    url = None
    steps: list[dict[str, Any]] = []
    ignored: list[str] = []

    for call in calls:
        action = call.func.attr
        if action == "goto" and url is None and call.args:
            url = _literal(call.args[0])
        if action not in SUPPORTED_ACTIONS:
            continue
        target = _locator_details(call.func.value)
        if target is None:
            ignored.append(f"line {call.lineno}: unsupported or unnamed locator for {action}")
            continue

        # Codegen frequently records focus-clicks just before filling inputs.
        # These are not intended workflow actions.
        if action == "click" and target["role"] in {
            "textbox", "searchbox", "combobox", "checkbox"
        }:
            continue

        step: dict[str, Any] = {"action": action, "target": target}
        if action in {"fill", "select_option"}:
            value = _literal(call.args[0]) if call.args else None
            if not isinstance(value, str):
                ignored.append(f"line {call.lineno}: unsupported value for {action}")
                continue
            step["value"] = value
        steps.append(step)

    # Treat the last recorded click as potentially externally consequential.
    # It requires deliberate user approval before it can be executed.
    for step in reversed(steps):
        if step["action"] == "click":
            step["requires_approval"] = True
            break

    return {
        "version": 1,
        "source_url": url,
        "steps": steps,
        "import_warnings": ignored,
    }
