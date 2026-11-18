import { expect, it } from "vitest";
import { mobileStageIdForConsent } from "./mobileGatewayActivation.stage.ts";

type Mobile = Parameters<typeof mobileStageIdForConsent>[0];
const stage = (id: string, consentRevision: number) =>
  ({ id, consentRevision }) as Mobile["stages"][number];
const journal = (stages: Mobile["stages"], retiredStages = 0): Mobile => ({
  stages,
  ...(retiredStages
    ? { retired: { stages: retiredStages, revisionFloor: 1, selections: 0, attempts: 0 } }
    : {}),
});

it("keeps the inputs' stage for its own revision and derives one after a consent change", () => {
  expect(mobileStageIdForConsent(journal([]), "inputs-stage", 1)).toBe("inputs-stage");
  expect(mobileStageIdForConsent(journal([stage("inputs-stage", 3)]), "inputs-stage", 3)).toBe(
    "inputs-stage",
  );
  // F3: revoke (rev 4) then grant (rev 5) fenced the original stage.
  expect(mobileStageIdForConsent(journal([stage("inputs-stage", 3)]), "inputs-stage", 5)).toBe(
    "inputs-stage.r5",
  );
  // Deterministic: a remint after restart finds the same derived stage.
  expect(
    mobileStageIdForConsent(
      journal([stage("inputs-stage", 3), stage("inputs-stage.r5", 5)]),
      "inputs-stage",
      5,
    ),
  ).toBe("inputs-stage.r5");
});

it("never reissues the inputs' id once it may have been retired", () => {
  // The base stage left the journal: its id must not come back at a newer revision.
  expect(mobileStageIdForConsent(journal([], 1), "inputs-stage", 7)).toBe("inputs-stage.r7");
  expect(
    mobileStageIdForConsent(journal([stage("inputs-stage.r7", 7)], 3), "inputs-stage", 7),
  ).toBe("inputs-stage.r7");
  // A base still present at this very revision keeps its id (published before a retirement).
  expect(mobileStageIdForConsent(journal([stage("inputs-stage", 7)], 2), "inputs-stage", 7)).toBe(
    "inputs-stage",
  );
});

it("stays within the 128-character stage token", () => {
  const long = "x".repeat(128);
  const derived = mobileStageIdForConsent(journal([stage(long, 1)]), long, 12_345);
  expect(derived).toHaveLength(128);
  expect(derived.endsWith(".r12345")).toBe(true);
});
