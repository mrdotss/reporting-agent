/**
 * The paper rendering's claim — decided by an executing assertion (Requirement 22.8).
 *
 * `approximation` — the reading view claims to approximate the delivered page. It presents the
 * permanent preview label plus "an approximation of the delivered page".
 *
 * `text_extract` — the reading view makes no claim about approximating the page. It presents
 * the preview label plus "a text extract" and names the presigned `.pdf` as the delivered result.
 *
 * ## Why this is `"approximation"` and why the test decides
 *
 * A component cannot observe a test result. Requirement 22.8 makes the view's claim
 * conditional on `app/test/paper-render.dom.test.tsx` passing — the test asserts
 * `PAPER_CLAIM === "approximation"` alongside the rendering checks that prove the claim is
 * earned. Setting this to `"approximation"` while the rendering is broken becomes impossible;
 * setting it to `"text_extract"` while the test passes stays permitted, because a more
 * conservative claim is always allowed.
 */
export const PAPER_CLAIM: "approximation" | "text_extract" = "approximation"
