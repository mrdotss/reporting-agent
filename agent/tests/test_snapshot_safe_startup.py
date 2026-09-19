"""Nothing computed at import may need to differ between instances (AgentCore Runtime V2).

On platform version V2 the runtime starts the process once, snapshots it, and restores
that snapshot for every instance. Whatever the agent computed while importing is then
identical in all of them and frozen at the moment of the snapshot: a random value or id,
the current time, a monotonic reference (which does not advance across a restore), the
process id and hostname (every restored instance reports PID 1 and `localhost`).

So those calls belong inside handlers, never at import. This walks every module under
`src/reporting_agent/` and fails on any such call that runs at import — at module level,
in a class body, or in a function's default arguments, which are evaluated when the
`def` runs. Calls inside a function or lambda body run per request and are fine.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Final

SOURCE: Final[Path] = Path(__file__).resolve().parent.parent / "src" / "reporting_agent"

PER_INSTANCE_CALLS: Final[frozenset[str]] = frozenset(
    {
        "uuid.uuid1",
        "uuid.uuid4",
        "uuid4",
        "os.urandom",
        "os.getpid",
        "socket.gethostname",
        "platform.node",
        "time.time",
        "time.time_ns",
        "time.monotonic",
        "time.monotonic_ns",
        "time.perf_counter",
        "datetime.now",
        "datetime.utcnow",
        "datetime.today",
        "date.today",
        "datetime.datetime.now",
        "datetime.datetime.utcnow",
        "datetime.date.today",
    }
)
"""Dotted call names whose result differs per instance or goes stale after a restore."""

PER_INSTANCE_MODULES: Final[frozenset[str]] = frozenset({"random", "secrets"})
"""Any call into these at import draws from state the snapshot then shares."""


def _dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return None if base is None else f"{base}.{node.attr}"
    return None


class _ImportTimeCalls(ast.NodeVisitor):
    """Collects calls that execute at import, skipping function and lambda bodies."""

    def __init__(self) -> None:
        self.found: list[tuple[int, str]] = []

    def visit_Call(self, node: ast.Call) -> None:
        name = _dotted(node.func)
        if name is not None and (
            name in PER_INSTANCE_CALLS or name.split(".", 1)[0] in PER_INSTANCE_MODULES
        ):
            self.found.append((node.lineno, name))
        self.generic_visit(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        # Decorators and defaults run when the `def` does; the body does not.
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)


def test_the_walk_sees_the_package() -> None:
    """Guard the guard: an empty walk would pass vacuously."""
    assert len(list(SOURCE.rglob("*.py"))) > 50


def test_no_module_computes_a_per_instance_value_at_import() -> None:
    offenders: list[str] = []
    for path in sorted(SOURCE.rglob("*.py")):
        visitor = _ImportTimeCalls()
        visitor.visit(ast.parse(path.read_text(), filename=str(path)))
        offenders.extend(
            f"{path.relative_to(SOURCE.parent)}:{line} calls {name}() at import"
            for line, name in visitor.found
        )
    assert offenders == [], (
        "On AgentCore V2 every instance is restored from one snapshot, so these values "
        "would be identical across instances and frozen at snapshot time. Compute them "
        "in the handler instead:\n" + "\n".join(offenders)
    )


def test_the_visitor_catches_what_it_claims_to() -> None:
    """The three import-time positions are caught; a function body is not."""
    source = (
        "import time, uuid, random\n"
        "STARTED = time.monotonic()\n"
        "class A:\n"
        "    ID = uuid.uuid4()\n"
        "def f(seed=random.random()):\n"
        "    return time.time()\n"
    )
    visitor = _ImportTimeCalls()
    visitor.visit(ast.parse(source))
    assert [name for _, name in visitor.found] == ["time.monotonic", "uuid.uuid4", "random.random"]
