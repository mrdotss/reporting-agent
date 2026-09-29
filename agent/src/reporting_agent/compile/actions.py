"""The Action register's runtime half: this run's findings, and the rows the report prints.

**Pure.** The findings are read from the snapshot by fixed rules, so the list is one
function of the document every other figure comes from:

* `housekeeping` — a resource whose `housekeeping` fact is not `none`;
* `backup` — a resource the snapshot recorded `backup_not_configured` for;
* `rightsizing` — an instance Compute Optimizer finds over- or under-provisioned;
* `advisor` — an Azure Advisor recommendation.

The app keeps the register — who owns an item, whether it was accepted or turned down —
and sends its state as it stood **before** this run (`action_register` in the payload).
The rows compare the two: a finding the register already holds keeps its owner and
status, a new one reads *New*, and an item the register held that this snapshot no
longer shows reads *Resolved*. That comparison is made here, against this run's own
snapshot, so the report is never a month behind what it measured.

The rows go onto the section as `supplied_rows` — text the verifier treats as the
template's own, exactly like the incidents typed on the run form. They carry no figure.
The same rows, with the findings, are persisted as `actions.json`: a re-verification
replays them, and the app reads the findings to update the register.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.messages import Messages
from reporting_agent.compile.snapshot_view import (
    HOUSEKEEPING_CLEAR_VALUE,
    HOUSEKEEPING_FACT_KEY,
    SnapshotView,
)

__all__ = [
    "ACTIONS_ARTIFACT",
    "ACTIONS_PAYLOAD_KEY",
    "ACTIONS_SECTION",
    "Finding",
    "action_rows",
    "actions_bundle",
    "advisor_answered",
    "checked_keys",
    "findings_of",
    "resolved_keys",
    "section_present",
]

ACTIONS_SECTION: Final[str] = "action_register"
ACTIONS_PAYLOAD_KEY: Final[str] = "action_register"
ACTIONS_ARTIFACT: Final[str] = "actions.json"
MAX_ROWS: Final[int] = 50
"""`compile/sections.MAX_AUTHOR_ROWS`: the last row says how many more the app holds."""

REGISTER_STATUSES: Final[frozenset[str]] = frozenset({"open", "accepted", "wont_do", "resolved"})
OWNERS: Final[frozenset[str]] = frozenset({"customer", "msp"})
RIGHTSIZING_FINDINGS: Final[frozenset[str]] = frozenset({"overprovisioned", "underprovisioned"})
ADVISOR_TYPE: Final[str] = "microsoft.advisor/recommendations"


@dataclass(frozen=True, slots=True)
class Finding:
    """One thing to act on. `key` is stable across months: kind and resource id."""

    key: str
    kind: str
    resource_id: str
    title: str


def findings_of(view: SnapshotView) -> tuple[Finding, ...]:
    """Every finding this snapshot holds, ordered by key. **Pure.**"""
    names = {resource.resource_id: resource.name for resource in view.resources}
    found: dict[str, Finding] = {}

    def add(kind: str, resource_id: str, title: str) -> None:
        key = f"{kind}:{resource_id}"
        found.setdefault(key, Finding(key=key, kind=kind, resource_id=resource_id, title=title[:240]))

    for resource in view.resources:
        facts = {fact.key: fact.value.strip() for fact in view.facts_for(resource.resource_id)}
        housekeeping = facts.get(HOUSEKEEPING_FACT_KEY, "")
        if housekeeping and housekeeping.casefold() != HOUSEKEEPING_CLEAR_VALUE:
            add("housekeeping", resource.resource_id, f"{resource.name}: {housekeeping}")
        finding = facts.get("rightsizing_finding", "")
        if finding.casefold() in RIGHTSIZING_FINDINGS:
            target = facts.get("recommended_type", "")
            add(
                "rightsizing",
                resource.resource_id,
                f"Resize {resource.name} ({finding})" + (f" to {target}" if target else ""),
            )
        if resource.resource_type.casefold() == ADVISOR_TYPE:
            text = facts.get("recommendation") or resource.name
            category = facts.get("category", "")
            add("advisor", resource.resource_id, f"{category}: {text}" if category else text)

    for gap_type, entries in view.gaps_by_type():
        if gap_type != "backup_not_configured":
            continue
        for gap in entries:
            add("backup", gap.resource_id, f"Back up {names.get(gap.resource_id, gap.resource_id)}")

    return tuple(found[key] for key in sorted(found))


BACKUP_FACT_KEYS: Final[frozenset[str]] = frozenset({"last_backup", "backup_vault", "last_backup_status", "last_restore_point"})


def checked_keys(view: SnapshotView) -> frozenset[str]:
    """The keys this snapshot **checked and found clear**. **Pure.**

    An item turns Resolved only on evidence, never because it is missing: a resource
    outside a narrowed run, or a backup call that failed, leaves no finding either, and
    resolving on absence would close items nobody fixed.

    * housekeeping — the resource carries a `housekeeping` fact, and it is `none`;
    * backup — the resource carries a backup fact (it has one);
    * rightsizing — the resource carries a finding that recommends no change;
    * advisor — Advisor answered this run (at least one recommendation is present), so a
      recommendation it no longer returns was acted on. Those keys cannot be listed here —
      the resource is gone — so :func:`action_rows` and the app test `advisor_answered`.
    """
    checked: set[str] = set()
    for resource in view.resources:
        facts = {fact.key: fact.value.strip() for fact in view.facts_for(resource.resource_id)}
        housekeeping = facts.get(HOUSEKEEPING_FACT_KEY)
        if housekeeping is not None and housekeeping.casefold() == HOUSEKEEPING_CLEAR_VALUE:
            checked.add(f"housekeeping:{resource.resource_id}")
        if BACKUP_FACT_KEYS & facts.keys():
            checked.add(f"backup:{resource.resource_id}")
        finding = facts.get("rightsizing_finding")
        if finding and finding.casefold() not in RIGHTSIZING_FINDINGS:
            checked.add(f"rightsizing:{resource.resource_id}")
    return frozenset(checked)


def advisor_answered(view: SnapshotView) -> bool:
    return any(resource.resource_type.casefold() == ADVISOR_TYPE for resource in view.resources)


def resolved_keys(
    register_keys: Sequence[str], findings: Sequence[Finding], checked: frozenset[str], *, advisor: bool
) -> frozenset[str]:
    """The register's keys this snapshot resolves: checked clear, or an Advisor
    recommendation no longer returned while Advisor answered. **Pure.**"""
    current = {finding.key for finding in findings}
    return frozenset(
        key for key in register_keys
        if key not in current and (key in checked or (advisor and key.startswith("advisor:")))
    )


def _register(raw: object) -> dict[str, Mapping[str, object]]:
    """The app's register, by key. Entries that are not the declared shape are skipped: the
    register decorates rows, and a bad entry must not stop a report."""
    if not isinstance(raw, list):
        return {}
    register: dict[str, Mapping[str, object]] = {}
    for entry in raw:
        if (
            isinstance(entry, Mapping)
            and isinstance(entry.get("key"), str)
            and entry.get("status") in REGISTER_STATUSES
        ):
            register[str(entry["key"])] = entry
    return register


def action_rows(
    findings: Sequence[Finding],
    register_raw: object,
    *,
    messages: Messages,
    resolved: frozenset[str] = frozenset(),
) -> list[list[str]]:
    """The section's rows: Action, Owner, Status, Since. **Pure.**

    A register item this snapshot no longer shows reads Resolved only when its key is in
    `resolved` (see :func:`resolved_keys`); otherwise it keeps the status the register gave
    it — nothing measured it this month."""
    register = _register(register_raw)
    status_text = {
        "new": messages.text("doc.actions.status.new"),
        "open": messages.text("doc.actions.status.open"),
        "accepted": messages.text("doc.actions.status.accepted"),
        "wont_do": messages.text("doc.actions.status.wont_do"),
        "resolved": messages.text("doc.actions.status.resolved"),
        "reopened": messages.text("doc.actions.status.reopened"),
    }
    owner_text = {"customer": messages.text("doc.actions.owner.customer"), "msp": messages.text("doc.actions.owner.msp")}
    this_report = messages.text("doc.actions.since.this_report")

    def owner(entry: Mapping[str, object] | None) -> str:
        value = entry.get("owner") if entry is not None else None
        return owner_text[value] if value in OWNERS else "—"  # type: ignore[index]

    def since(entry: Mapping[str, object] | None) -> str:
        value = entry.get("since") if entry is not None else None
        return value[:40] if isinstance(value, str) and value else this_report

    current = {finding.key for finding in findings}
    rows: list[list[str]] = []
    for finding in findings:
        entry = register.get(finding.key)
        status = entry.get("status") if entry is not None else None
        label = (
            status_text["new"] if status is None
            else status_text["reopened"] if status == "resolved"
            else status_text[str(status)]
        )
        rows.append([finding.title, owner(entry), label, since(entry)])
    for key in sorted(register):
        entry = register[key]
        if key in current or entry.get("status") == "resolved":
            continue
        title = entry.get("title")
        rows.append([
            str(title)[:240] if isinstance(title, str) and title else key,
            owner(entry),
            status_text["resolved"] if key in resolved else status_text[str(entry.get("status"))],
            since(entry),
        ])

    if not rows:
        return [[messages.text("doc.actions.none"), "", "", ""]]
    if len(rows) > MAX_ROWS:
        more = len(rows) - (MAX_ROWS - 1)
        rows = [*rows[: MAX_ROWS - 1], [messages.text("doc.actions.more", count=str(more)), "", "", ""]]
    return rows


def section_present(definition: Mapping[str, object]) -> bool:
    sections = definition.get("sections")
    return isinstance(sections, list) and any(
        isinstance(section, Mapping) and section.get("type") == ACTIONS_SECTION for section in sections
    )


def actions_bundle(
    findings: Sequence[Finding],
    rows: list[list[str]] | None,
    *,
    checked: frozenset[str] = frozenset(),
    advisor: bool = False,
) -> dict[str, object]:
    """`actions.json`: the findings, what was checked clear, and whether Advisor answered —
    what the app resolves its register by, with the same rules — and the rows a
    re-verification replays."""
    return {
        "schema_version": 1,
        "findings": [
            {"key": f.key, "kind": f.kind, "resource_id": f.resource_id, "title": f.title} for f in findings
        ],
        "checked": sorted(checked),
        "advisor_answered": advisor,
        **({"rows": rows} if rows is not None else {}),
    }
