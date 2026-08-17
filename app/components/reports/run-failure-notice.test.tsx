import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { RunView } from "@/lib/db/views"
import {
  EMPTY_SCOPE_CAUSES,
  EMPTY_SCOPE_HEADLINE,
  RUN_FAILURE_PRESENTATION,
} from "@/lib/runs/presentation"

import { RunFailureNotice } from "./run-failure-notice"

/**
 * The failure notice (Requirements 33.4, 36.7).
 *
 * ## What is real
 *
 * The notice and `runFailurePresentation`. Nothing computes a presentation for this file
 * to render — the fixtures are `RunView`s, exactly what the page passes — so what is on
 * screen is what a consultant sees for that row. A test that handed the component a
 * pre-built headline would assert only that a component can render a string it was given.
 *
 * ## `EMPTY_SCOPE` gets four separate assertions
 *
 * Because it has four jobs, and each is a thing the screen would otherwise omit
 * plausibly: state that zero resources were found, name the subscription **and** the
 * period, state that **no artifact was produced**, and list the two causes.
 *
 * The reason all four matter is that the alternative outcome is worse than a failure. An
 * expired secret returns zero resources, zero resources produce zero figures, and zero
 * figures pass every verification gate — so without this hard failure the run would
 * deliver a clean, fully-verified, **empty** report. A notice that only said "failed"
 * would leave the consultant unable to tell that case from a transient one.
 *
 * Assertions are against the exported constants rather than against paraphrases of them,
 * so editing the copy does not silently break the test into meaninglessness.
 */

const SUBSCRIPTION_LABEL =
  "Contoso production — ********-****-****-****-****3301"

function view(over: Partial<RunView> = {}): RunView {
  return {
    id: "run-1",
    connectedSubscriptionId: "sub-1",
    status: "failed",
    errorCode: "EMPTY_SCOPE",
    errorMessage: "The requested scope resolved to zero resources.",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    resourceCount: null,
    gapCount: null,
    snapshotId: null,
    artifactKeys: [],
    createdAt: "2026-08-15T09:50:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    templateName: null,
    templateVersion: null,
    verificationStatus: null,
    ...over,
  }
}

function renderNotice(run: RunView) {
  return render(
    <RunFailureNotice run={run} subscriptionLabel={SUBSCRIPTION_LABEL} />
  )
}

afterEach(cleanup)

// ---------------------------------------------------------------------------

describe("it renders only for a failed run", () => {
  test.each(["queued", "claimed", "collecting", "completed"] as const)(
    "a %s run renders nothing",
    (status) => {
      const { container } = renderNotice(
        view({ status, errorCode: null, errorMessage: null })
      )

      expect(container.firstChild).toBeNull()
    }
  )

  test("a failed run renders the notice", () => {
    renderNotice(view())

    expect(
      document.querySelector('[data-slot="run-failure-notice"]')
    ).not.toBeNull()
  })
})

describe("Requirement 33.4 — the EMPTY_SCOPE copy does all four jobs", () => {
  test("it states that zero resources were found", () => {
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    expect(screen.getByText(EMPTY_SCOPE_HEADLINE)).toBeTruthy()
  })

  test("it names the subscription and the period", () => {
    // A failure notice that did not say which subscription and which month it was about
    // would be a sentence a consultant cannot act on — they run several a week.
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    expect(screen.getByText(SUBSCRIPTION_LABEL)).toBeTruthy()
    expect(screen.getByText(/2026-07-01 to 2026-07-31/)).toBeTruthy()
    // The zone travels with the dates: "July" means July there, not in UTC.
    expect(screen.getByText(/Asia\/Jakarta/)).toBeTruthy()
  })

  test("it states that no artifact was produced", () => {
    // Stated rather than implied. A notice that only said "zero resources" would leave a
    // consultant looking for a download link that is not coming.
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    const artifact = document.querySelector('[data-slot="no-artifact"]')

    expect(artifact?.textContent).toContain("No report was produced")
    expect(artifact?.textContent).toContain("nothing to download")
  })

  test("it lists an expired secret and a below-scope Reader assignment", () => {
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    const causes = document.querySelector('[data-slot="failure-causes"]')

    expect(causes).not.toBeNull()

    for (const cause of EMPTY_SCOPE_CAUSES) {
      expect(causes?.textContent).toContain(cause)
    }

    // The two named causes, checked by their distinguishing phrases as well as by the
    // constants — so a rewrite that dropped one of the two facts fails here.
    expect(causes?.textContent).toMatch(/expired/i)
    expect(causes?.textContent).toMatch(/resource group/i)
  })

  test("the code travels as a data attribute for the UI to branch on", () => {
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    expect(
      document
        .querySelector('[data-slot="run-failure-notice"]')
        ?.getAttribute("data-error-code")
    ).toBe("EMPTY_SCOPE")
  })
})

describe("Requirement 36.7 — a TIMEOUT row renders terminal state with no event", () => {
  test("it explains the timeout from the row alone", () => {
    // `TIMEOUT` is written by the reaper when the run's container may already be gone, so
    // there is no stream left to carry an `error` event. This component receives only a
    // row — no events at all — and still renders a full explanation. A screen that read
    // its terminal state from the stream would show this run as still collecting, forever.
    renderNotice(
      view({
        errorCode: "TIMEOUT",
        errorMessage: "Phase collecting exceeded its deadline.",
      })
    )

    expect(
      screen.getByText(RUN_FAILURE_PRESENTATION.TIMEOUT.headline)
    ).toBeTruthy()

    expect(
      document.querySelector('[data-slot="no-artifact"]')?.textContent
    ).toContain("No report was produced")
  })

  test("the runtime's own message is supporting detail, not the headline", () => {
    // It is prose written for a log and it varies with the code path that produced it,
    // while the headline is the same sentence every time for a given code. Both are
    // present; only one is the heading.
    renderNotice(
      view({
        errorCode: "TIMEOUT",
        errorMessage: "Phase collecting exceeded its deadline.",
      })
    )

    const heading = screen.getByRole("heading", { level: 2 })

    expect(heading.textContent).toBe(RUN_FAILURE_PRESENTATION.TIMEOUT.headline)
    expect(
      screen.getByText("Phase collecting exceeded its deadline.")
    ).toBeTruthy()
  })

  test("a row with no message still renders the headline", () => {
    renderNotice(view({ errorCode: "TIMEOUT", errorMessage: null }))

    expect(
      screen.getByText(RUN_FAILURE_PRESENTATION.TIMEOUT.headline)
    ).toBeTruthy()
  })
})

describe("every declared code has copy, and none of it is a bare code", () => {
  test.each(
    Object.keys(
      RUN_FAILURE_PRESENTATION
    ) as (keyof typeof RUN_FAILURE_PRESENTATION)[]
  )("%s renders a sentence rather than the code", (code) => {
    // The `Record` keyed by `RunErrorCode` is total, so a code added to the Postgres
    // enum is a compile error rather than a screen showing `NO_STATISTICS` verbatim.
    // This asserts the runtime half: the rendered text is prose, and the raw code
    // appears only in the data attribute.
    renderNotice(view({ errorCode: code, errorMessage: null }))

    const notice = document.querySelector('[data-slot="run-failure-notice"]')

    expect(notice?.textContent).toContain(
      RUN_FAILURE_PRESENTATION[code].headline
    )
    expect(notice?.textContent).not.toContain(code)
  })

  test("a failed row with no code still says no report was produced", () => {
    // Unreachable through the database — the CHECK requires a code on a `failed` row —
    // but the type is nullable, and the fallback must not be a blank panel.
    renderNotice(view({ errorCode: null, errorMessage: null }))

    expect(
      document.querySelector('[data-slot="no-artifact"]')?.textContent
    ).toContain("No report was produced")
  })
})

describe("`--destructive` is spent here, and only on the failure itself", () => {
  test("the notice carries the destructive token", () => {
    // One of the two places the token is allowed: a hard run failure is exactly what it
    // means — *this document could not be proven*.
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    const notice = document.querySelector('[data-slot="run-failure-notice"]')

    expect(notice?.className).toMatch(/destructive/)
  })

  test("the causes list does not", () => {
    // "What to check" is guidance, not a failure. Red on it would spend the token twice
    // in one panel and dilute the one meaning it has.
    renderNotice(view({ errorCode: "EMPTY_SCOPE" }))

    expect(
      document.querySelector('[data-slot="failure-causes"]')?.className
    ).not.toMatch(/destructive/)
  })
})
