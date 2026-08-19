import { describe, expect, test } from "vitest"

import {
  ARTIFACT_SEGMENT_REPORTS,
  ARTIFACT_SEGMENT_SNAPSHOTS,
  DOWNLOADABLE_SEGMENTS,
  ArtifactAccessError,
  MAX_PRESIGN_SECONDS,
  keyBelongsToActor,
  parseArtifactKey,
  presignArtifact,
} from "@/lib/aws/s3"
import { snapshotArtifactKey } from "@/lib/db/views"

/**
 * `lib/aws/s3.ts` — the pure half (Requirements 37.8, 37.12).
 *
 * `keyBelongsToActor` is the authorization primitive for every artifact
 * download, and the two cases the design names — `alice-evil/...` and
 * `other/alice/...` — are here because they are the two a `startsWith`
 * implementation gets wrong. That is not a hypothetical: `"alice-evil/snapshots/
 * r/x".startsWith("alice")` is `true`, so the naive version hands an attacker who
 * can pick their own user id a presigned URL for somebody else's report.
 *
 * The presigner itself is not exercised against AWS here. What *is* asserted is
 * that authorization happens **before** any AWS call, which is observable without
 * credentials: a refused key rejects rather than reaching for a client, a region
 * or a bucket name.
 */

const ACTOR = "alice"
const RUN = "run-01HZX9"

/** The one key layout, built by the module that writes it. */
const OWN_KEY = snapshotArtifactKey(ACTOR, RUN)

describe("parseArtifactKey — the key layout", () => {
  test("the layout this module reads is the layout lib/db/views.ts writes", () => {
    // Two copies of a path template is how the authorization check ends up
    // guarding a key nothing writes. Asserted against the writer, not restated.
    expect(OWN_KEY).toBe("alice/snapshots/run-01HZX9/snapshot.json")

    const parsed = parseArtifactKey(OWN_KEY)

    expect(parsed).toEqual({
      actorId: ACTOR,
      kind: "snapshots",
      runId: RUN,
      rest: "snapshot.json",
    })
  })

  test("the second segment is exactly `snapshots` or exactly `reports`", () => {
    expect(ARTIFACT_SEGMENT_SNAPSHOTS).toBe("snapshots")
    expect(ARTIFACT_SEGMENT_REPORTS).toBe("reports")
    expect([...DOWNLOADABLE_SEGMENTS].sort()).toEqual(["reports", "snapshots"])
    expect(OWN_KEY.split("/")[1]).toBe(ARTIFACT_SEGMENT_SNAPSHOTS)

    expect(parseArtifactKey(`${ACTOR}/reports/${RUN}/report.pdf`)).toEqual({
      actorId: ACTOR,
      kind: "reports",
      runId: RUN,
      rest: "report.pdf",
    })
  })

  test("a preview key is not parseable, so the download path cannot serve one", () => {
    // Requirement 43.2. `previews` is outside the set deliberately: a preview is
    // presented inline by a route with its own key template, and keeping it out
    // of this predicate makes "a preview is not a report" a property of the key
    // space rather than a rule either route has to remember.
    expect(DOWNLOADABLE_SEGMENTS.has("previews")).toBe(false)
    expect(parseArtifactKey(`${ACTOR}/previews/pv-1/preview.pdf`)).toBeNull()
    expect(keyBelongsToActor(ACTOR, `${ACTOR}/previews/pv-1/preview.pdf`)).toBe(
      false
    )
  })

  test("`rest` is the whole remainder, not just a file name", () => {
    // The raw archive lands at `raw/<n>.json.gz` under the same run prefix, so
    // the remainder has to survive further slashes.
    expect(
      parseArtifactKey(`${ACTOR}/snapshots/${RUN}/raw/0001.json.gz`)
    ).toEqual({
      actorId: ACTOR,
      kind: "snapshots",
      runId: RUN,
      rest: "raw/0001.json.gz",
    })
  })

  test.each([
    ["", "the empty key"],
    ["alice", "one segment"],
    ["alice/snapshots", "two segments"],
    ["alice/snapshots/run-1", "a run prefix, which is not an object"],
    ["/alice/snapshots/run-1/snapshot.json", "a leading slash"],
    ["alice//run-1/snapshot.json", "an empty second segment"],
    ["alice/snapshots//snapshot.json", "an empty run id"],
    ["alice/snapshots/run-1/", "an empty remainder"],
    ["alice/Snapshots/run-1/snapshot.json", "a case-differing second segment"],
    ["alice/snapshot/run-1/snapshot.json", "a singular second segment"],
    ["alice/ledgers/run-1/ledger.json", "some other second segment"],
  ])("%s does not parse (%s)", (key) => {
    expect(parseArtifactKey(key)).toBeNull()
  })
})

describe("keyBelongsToActor — Requirement 37.12, exact segment match", () => {
  test("an actor's own key is authorized", () => {
    expect(keyBelongsToActor(ACTOR, OWN_KEY)).toBe(true)
  })

  test("`alice-evil/...` is refused for `alice`", () => {
    // The case that kills `key.startsWith(actorId)`. An attacker who can choose
    // their own id chooses one with a victim's id as a prefix.
    const evil = snapshotArtifactKey("alice-evil", RUN)

    expect(evil.startsWith(ACTOR)).toBe(true)
    expect(keyBelongsToActor(ACTOR, evil)).toBe(false)
  })

  test("`other/alice/...` is refused for `alice`", () => {
    // `alice` appears in the key, and in the position a sloppy `includes` or a
    // "find the id anywhere in the prefix" check would accept. Only segment 0
    // names the owner.
    const other = `other/${ACTOR}/${RUN}/snapshot.json`

    expect(other).toContain(ACTOR)
    expect(keyBelongsToActor(ACTOR, other)).toBe(false)
  })

  test.each([
    ["alicE/snapshots/run-1/snapshot.json", "a case-differing actor id"],
    ["ali/snapshots/run-1/snapshot.json", "a shorter actor id"],
    ["alice /snapshots/run-1/snapshot.json", "a trailing space in the segment"],
    [" alice/snapshots/run-1/snapshot.json", "a leading space in the segment"],
    ["bob/snapshots/run-1/snapshot.json", "another actor entirely"],
  ])("%s is refused (%s)", (key) => {
    expect(keyBelongsToActor(ACTOR, key)).toBe(false)
  })

  test("a key that does not parse is never authorized", () => {
    // Authorization is defined over parsed keys, so "well-formed" and "mine" are
    // one question and cannot be answered separately by two call sites.
    expect(keyBelongsToActor(ACTOR, "alice")).toBe(false)
    expect(keyBelongsToActor(ACTOR, "alice/snapshots/run-1")).toBe(false)
    expect(keyBelongsToActor(ACTOR, "alice/ledgers/run-1/x.json")).toBe(false)
  })

  test("an empty actor id matches nothing, including an empty first segment", () => {
    // `"".startsWith` is true of every string, so an empty candidate is where a
    // prefix check degenerates into authorizing everything.
    expect(keyBelongsToActor("", OWN_KEY)).toBe(false)
    expect(keyBelongsToActor("", "/snapshots/run-1/snapshot.json")).toBe(false)
  })

  test("an actor id carrying a slash cannot span segments", () => {
    // A segment never contains `/`, so this can only ever be false — which is
    // the point: an id shaped like a path cannot be made to match two segments.
    expect(keyBelongsToActor("alice/snapshots", OWN_KEY)).toBe(false)
  })
})

describe("presignArtifact — Requirement 37.8", () => {
  test("the maximum expiry is 300 seconds", () => {
    expect(MAX_PRESIGN_SECONDS).toBe(300)
  })

  test("a key that is not the actor's mints no URL and makes no AWS call", async () => {
    // Observable without credentials: no region and no bucket name are set in
    // this test's environment, so anything that reached a client or `requireEnv`
    // would fail with a *different* error. `ArtifactAccessError` is the proof
    // that authorization ran first.
    await expect(
      presignArtifact(ACTOR, snapshotArtifactKey("alice-evil", RUN))
    ).rejects.toBeInstanceOf(ArtifactAccessError)

    await expect(
      presignArtifact(ACTOR, `other/${ACTOR}/${RUN}/snapshot.json`)
    ).rejects.toBeInstanceOf(ArtifactAccessError)
  })

  test("the refusal message names no key and no user id", async () => {
    // It is logged verbatim on the not-found path, so it must not become the
    // place a probed key gets recorded.
    let caught: Error | undefined
    try {
      await presignArtifact(ACTOR, snapshotArtifactKey("alice-evil", RUN))
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(ArtifactAccessError)
    expect(caught?.message).not.toContain(ACTOR)
    expect(caught?.message).not.toContain(RUN)
  })
})
