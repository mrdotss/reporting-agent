"""The verification result's `template_version_id` is a foreign key, not a label.

## What this exists to stop

`report_verifications.template_version_id` references `report_template_versions.id`.
The only value that satisfies it is the row id the app pinned at enqueue, and the app
sends exactly that at the top level of the invoke payload, beside `definition`
(Req 9.6, `app/lib/aws/agentcore.ts`).

The pipeline used to ignore it and read `definition.identity.version_id`, falling back
to the **run id**. A wizard-authored definition carries no `version_id` under `identity`
— that object holds the name, description and report title — so the fallback was not a
fallback. It was the only branch taken on every real run, and a run id is not a template
version id.

The consequence was invisible until a run first reached verification: the insert failed
with a Postgres 23503, the progress callback answered 500 twice and was abandoned, no
`report_verifications` row was stored, and the run could not reach `completed` because
Req 41.1 requires the stored `pass` row it had just failed to store. A document that had
passed every gate was withheld on the strength of a foreign key — and the run then sat
until the Reaper called it a timeout.

Every test passed throughout, because the harness payloads and the definition fixtures
both happen to carry a plausible id and nothing asserted **which one** was used. That is
the gap this file closes: it asserts the provenance of the value, not merely its shape.
"""

from __future__ import annotations

import pytest

from reporting_agent.errors import CompileFailedError
from reporting_agent.report_pipeline import payload_version_id, pinned_version_id

PINNED = "tv_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HZX8QW9K7YB4T2C3M5N6P7QR"

#: What the wizard actually saves. Note the absence of `version_id` — this is the shape
#: that made the old fallback unconditional.
WIZARD_DEFINITION = {
    "identity": {
        "name": "Monthly utilization",
        "description": "",
        "report_title": "Monthly utilization",
    },
}


def test_the_payload_s_pinned_id_is_what_is_used() -> None:
    """The whole defect in one assertion.

    The definition is the real wizard shape, so the old code reached its `or run_id`
    branch here and returned the run id.
    """
    payload = {"template_version_id": PINNED, "run_id": RUN_ID}

    assert pinned_version_id(payload, WIZARD_DEFINITION) == PINNED


def test_the_pinned_id_wins_over_one_embedded_in_the_definition() -> None:
    """Both present is not a tie.

    A definition is content and can be edited or copied between templates; the payload's
    id is the row the run pinned. Only one of them is the foreign key's referent, and it
    is never the one inside the document.
    """
    payload = {"template_version_id": PINNED, "run_id": RUN_ID}
    definition = {"identity": {**WIZARD_DEFINITION["identity"], "version_id": "tv_OTHER"}}

    assert pinned_version_id(payload, definition) == PINNED


def test_an_inline_definition_may_still_name_its_own_version() -> None:
    """`render_preview` supplies a definition with no pinned row behind it, so the
    definition-derived id remains the fallback rather than being removed."""
    payload: dict[str, object] = {"run_id": RUN_ID}
    definition = {"identity": {**WIZARD_DEFINITION["identity"], "version_id": "tv_INLINE"}}

    assert pinned_version_id(payload, definition) == "tv_INLINE"


def test_the_run_id_is_never_the_answer() -> None:
    """The specific wrong value, named.

    Asserting "not the run id" rather than only "raises" is deliberate: the failure mode
    was not an exception, it was a confidently-returned value that no foreign key could
    accept. A future change that reintroduces any such fallback fails here even if it
    picks a different one, because nothing but a real version id may be returned.
    """
    payload: dict[str, object] = {"run_id": RUN_ID}

    with pytest.raises(CompileFailedError) as raised:
        pinned_version_id(payload, WIZARD_DEFINITION)

    assert RUN_ID not in str(raised.value)
    assert "template_version_id" in str(raised.value)


@pytest.mark.parametrize("value", ["", "   ", None, 42, [], {}])
def test_an_unusable_pinned_value_is_not_accepted_as_one(value: object) -> None:
    """An empty or non-string `template_version_id` is absent, not a value.

    Passing `""` through would trade a 23503 for a not-null/format failure one layer
    down, which is the same outage wearing a different error code.
    """
    payload = {"template_version_id": value, "run_id": RUN_ID}

    with pytest.raises(CompileFailedError):
        pinned_version_id(payload, WIZARD_DEFINITION)


def test_the_definition_reader_still_reports_absence_honestly() -> None:
    """`payload_version_id` is unchanged and still returns `None` for the wizard shape —
    which is precisely the fact the old call site turned into a run id."""
    assert payload_version_id(WIZARD_DEFINITION) is None
