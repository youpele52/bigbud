import { expect, it } from "vitest";
import {
  parseV2CanonicalCandidate,
  renderV2CanonicalCandidateGuard,
} from "./NativeCompatibility.version.ts";
import { assertV2SharedQualifiedVersion } from "./SharedService.compatibility.ts";

it.each(["2.0.0", "2.0.24", "2.0.25", "2.0.26", "2.0.27", "2.0.28", "2.1.0", "2.999.999"])(
  "%s is a candidate, not execution authority",
  (version) => {
    expect(parseV2CanonicalCandidate(version)?.version).toBe(version);
  },
);

it.each([
  "1.0.26",
  "3.0.0",
  "2.00.26",
  "02.0.26",
  "2.0.026",
  "v2.0.28",
  " 2.0.28",
  "2.0.28\n",
  "2.0.28-dev",
  "2.0.28+custom",
  "2.9007199254740992.0",
  "2.0.-1",
  "2.0",
  "",
])("rejects non-candidate %j without widening discovery", (version) => {
  expect(parseV2CanonicalCandidate(version)).toBeUndefined();
});

it("discovery, generated bootstrap and broker accept stable V2 without patch/minor cutoffs", () => {
  for (const version of [
    "2.0.0",
    "2.0.24",
    "2.0.25",
    "2.0.26",
    "2.0.27",
    "2.0.28",
    "2.1.0",
    "2.999.999",
  ]) {
    expect(() => assertV2SharedQualifiedVersion(version)).not.toThrow();
    expect(parseV2CanonicalCandidate(version)?.version).toBe(version);
  }
  // Generator-output parser conformance only, not native execution or dynamic production loading.
  const emitted = new Function(`${renderV2CanonicalCandidateGuard()};return candidate;`)() as (
    v: unknown,
  ) => boolean;
  for (const version of [
    "2.0.0",
    "2.0.25",
    "2.0.26",
    "2.0.27",
    "2.0.28",
    "2.2.0",
    "2.999.999",
    "1.0.0",
    "3.0.0",
    "2.0.28-dev",
    "2.0.28+custom",
    "2.00.28",
    "2.9007199254740992.0",
    undefined,
    null,
    2,
  ])
    expect(emitted(version)).toBe(Boolean(parseV2CanonicalCandidate(version)));
});
