import { expect, it } from "vitest";
import { mobileStageIdForConsent } from "./mobileGatewayActivation.stage.ts";

const stage = (id: string, consentRevision: number) =>
  ({ id, consentRevision }) as Parameters<typeof mobileStageIdForConsent>[0][number];

it("keeps the inputs' stage for its own revision and derives one after a consent change", () => {
  expect(mobileStageIdForConsent([], "inputs-stage", 1)).toBe("inputs-stage");
  expect(mobileStageIdForConsent([stage("inputs-stage", 3)], "inputs-stage", 3)).toBe(
    "inputs-stage",
  );
  // F3: revoke (rev 4) then grant (rev 5) fenced the original stage forever.
  expect(mobileStageIdForConsent([stage("inputs-stage", 3)], "inputs-stage", 5)).toBe(
    "inputs-stage.r5",
  );
  // Deterministic: a remint after restart finds the same derived stage.
  expect(
    mobileStageIdForConsent(
      [stage("inputs-stage", 3), stage("inputs-stage.r5", 5)],
      "inputs-stage",
      5,
    ),
  ).toBe("inputs-stage.r5");
});

it("stays within the 128-character stage token", () => {
  const long = "x".repeat(128);
  const derived = mobileStageIdForConsent([stage(long, 1)], long, 12_345);
  expect(derived).toHaveLength(128);
  expect(derived.endsWith(".r12345")).toBe(true);
});
