"""Pytest and hypothesis configuration for the agent test suite.

The profile registered here is the mechanism behind three requirements, so the
settings are not tuning knobs:

* **Req 42.2** — every agent-side property runs at least 100 generated examples.
  `max_examples=100` is the floor, applied by default rather than per test, so a
  property cannot silently declare fewer.
* **Req 42.4** — a failing property reports the shrunk counterexample together with
  something that re-runs it. `print_blob=True` prints the `@reproduce_failure(...)`
  decorator to paste back into the test.
* **Req 42.6** — a property that discards nearly every generated input must FAIL
  rather than pass on the handful that survived. `HealthCheck.filter_too_much` and
  `HealthCheck.data_too_large` are the mechanism, so there is deliberately **no**
  `suppress_health_check` argument below. Do not add one. A property whose
  preconditions reject most of its input is reporting green while testing almost
  nothing, which is worse than having no test.

`deadline=None` because these properties fold thousands of `Decimal` values and a
per-example wall-clock deadline would turn a slow machine into a flaky suite. Timing
is not what any of them assert.

`derandomize=False` keeps generation seeded from entropy, so the suite keeps looking
for new counterexamples run to run instead of replaying one fixed set forever.

Req 42.8 — retaining a fixed counterexample — is satisfied by an explicit
`@example(...)` decorator on the property itself, which is committed and therefore
runs for everyone. The example database below is the local convenience that replays
a freshly discovered counterexample first on the next run, before that `@example` is
written. It is an addition to `@example`, never a substitute: `.hypothesis/` is
git-ignored, so nothing in it is shared or reviewable.
"""

from dataclasses import replace
from pathlib import Path

import pytest
from hypothesis import HealthCheck, settings
from hypothesis.database import DirectoryBasedExampleDatabase
from hypothesis.statistics import collector

# `tests/` is on `sys.path` under pytest's prepend import mode, which is how every helper
# module in this directory is imported (`import snapshot_factory`, `import negatives`).
import property_ledger

# agent/ — the parent of tests/. Anchoring to this file rather than to the working
# directory keeps the database in one place however pytest is invoked.
AGENT_ROOT = Path(__file__).resolve().parent.parent

PROFILE_NAME = "reporting-agent"

settings.register_profile(
    PROFILE_NAME,
    settings(
        max_examples=100,  # Req 42.2 — the floor, not a target
        deadline=None,
        print_blob=True,  # Req 42.4 — prints @reproduce_failure(...)
        derandomize=False,
        database=DirectoryBasedExampleDatabase(AGENT_ROOT / ".hypothesis" / "examples"),
        # NO suppress_health_check. See Req 42.6 in the module docstring.
    ),
)

settings.load_profile(PROFILE_NAME)

# Fail loudly at collection if the profile did not take effect. A property suite that
# runs 10 examples under a default profile looks identical to one running 100.
assert settings.default.max_examples == 100, settings.default.max_examples
assert settings.default.deadline is None, settings.default.deadline
assert settings.default.print_blob is True, settings.default.print_blob
assert HealthCheck.filter_too_much not in settings.default.suppress_health_check
assert HealthCheck.data_too_large not in settings.default.suppress_health_check

# ---------------------------------------------------------------------------------
# Req 45.8 — what each property actually did, in the suite's own output
# ---------------------------------------------------------------------------------
#
# The profile above declares the floor. It cannot show that a property *reached* it: a
# generator that runs out of inputs, or preconditions that discard most of what is drawn,
# both leave the declaration correct and the run thin. hypothesis knows the real numbers —
# it publishes them through `hypothesis.statistics.collector`, the same stream behind
# `--hypothesis-show-statistics` — so they are read from there rather than re-derived.
#
# `tests/property_ledger.py` holds the records, the declared property set and the
# thresholds; `tests/test_property_hygiene.py` gates on them. This hook only fills the
# ledger and prints it.
#
# **On chaining.** hypothesis's own pytest plugin installs a collector callback per test,
# inside its own `pytest_runtest_call` wrapper, and `collector` is a dynamic variable — so
# whichever wrapper is innermost is the one hypothesis calls. `trylast=True` puts this one
# inside, and it forwards to whatever callback it displaced. Without that forwarding,
# `--hypothesis-show-statistics` would silently print nothing; the assertion at the end of
# `test_property_hygiene.py`'s recording test is what would notice if the nesting ever
# inverted, because the ledger would come back empty.


@pytest.hookimpl(hookwrapper=True, trylast=True)
def pytest_runtest_call(item):
    displaced = collector.value

    def observe(stats) -> None:
        module, _, function = item.nodeid.rpartition("::")
        accepted, rejected, overrun = property_ledger.case_counts(stats)
        property_ledger.record(
            property_ledger.Execution(
                nodeid=item.nodeid,
                module=Path(module).name,
                function=function,
                framework=property_ledger.HYPOTHESIS,
                accepted=accepted,
                rejected=rejected,
                overrun=overrun,
                # Filled in after the call: hypothesis sets the generated seed on the
                # wrapped test, and it is the value `@seed(...)` would carry.
                seed="",
                stopped_because=str(stats.get("stopped-because", "")),
            )
        )
        if displaced is not None:
            displaced(stats)

    with collector.with_value(observe):
        yield

    existing = property_ledger.execution_for(item.nodeid)
    if existing is not None and not existing.seed:
        seed = getattr(item.obj, "_hypothesis_internal_use_generated_seed", None)
        property_ledger.record(
            replace(
                existing,
                seed=str(seed) if seed is not None else f"derandomized:{item.nodeid}",
            )
        )


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    """Req 45.8 — the four recorded values, in the terminal, on every run."""
    if not property_ledger.executions():
        return
    terminalreporter.write_sep("=", "Property ledger")
    for line in property_ledger.format_table():
        terminalreporter.write_line(line)
