import { describe, expect, it } from "vitest";
import {
  classifyConsentError,
  CLOSED_REVIEW,
  consentInputFromReview,
  reviewAfterStale,
  reviewFromStatus,
} from "./RemoteBackendUpdate.consent";
import {
  APPROVAL,
  DIGEST_A,
  DIGEST_B,
  OPERATION_ID,
  operation,
  status,
  TURN,
  typedError,
} from "./RemoteBackendUpdate.test.fixtures";

describe("interruption consent digest handling", () => {
  it("binds consent to the operation id and the digest of the list on screen", () => {
    const review = reviewFromStatus(
      status(operation("deferred"), [TURN, APPROVAL], DIGEST_A),
      false,
    );
    expect(review).toMatchObject({ phase: "review", work: [TURN, APPROVAL], changed: false });
    expect(consentInputFromReview(review)).toEqual({
      operationId: OPERATION_ID,
      affectedWorkDigest: DIGEST_A,
    });
  });

  it("never yields a consent payload without a reviewable list", () => {
    expect(consentInputFromReview(CLOSED_REVIEW)).toBeNull();
    expect(consentInputFromReview({ phase: "loading" })).toBeNull();
    const review = reviewFromStatus(status(operation("staged"), [TURN]), false);
    if (review.phase !== "review") throw new Error("expected review");
    // A submission in flight cannot be sent twice.
    expect(consentInputFromReview({ ...review, submitting: true })).toBeNull();
  });

  it("explains instead of reviewing when nothing is consentable", () => {
    expect(reviewFromStatus(status(operation("staging"), [TURN]), false).phase).toBe("unavailable");
    expect(reviewFromStatus(status(operation("deferred")), false).phase).toBe("unavailable");
    expect(
      reviewFromStatus(status(operation("deferred", { consent: "consumed" }), [TURN]), false),
    ).toMatchObject({ phase: "unavailable", message: expect.stringMatching(/already used/) });
    expect(reviewFromStatus(status(null), false).phase).toBe("unavailable");
  });
});

describe("stale consent re-confirmation", () => {
  it("asks for a fresh confirmation on consent-stale and never re-sends by itself", () => {
    expect(classifyConsentError(typedError("consent-stale"))).toEqual({ kind: "reconfirm" });
    const refreshed = reviewAfterStale(status(operation("deferred"), [TURN], DIGEST_B));
    expect(refreshed).toMatchObject({ phase: "review", changed: true, submitting: false });
    // The new payload names only the new digest the user is now shown.
    expect(consentInputFromReview(refreshed)?.affectedWorkDigest).toBe(DIGEST_B);
  });

  it("settles reused consent and surfaces other failures", () => {
    expect(classifyConsentError(typedError("consent-reused")).kind).toBe("settled");
    expect(classifyConsentError(typedError("invalid-state", "Not staged yet."))).toEqual({
      kind: "failed",
      message: "Not staged yet.",
    });
    expect(classifyConsentError(new Error("socket closed"))).toEqual({
      kind: "failed",
      message: "socket closed",
    });
  });
});
