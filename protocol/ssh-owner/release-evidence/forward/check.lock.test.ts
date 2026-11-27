import { describe, expect, it } from "vitest";
import { checkForwardBoundary } from "./check.ts";

import { fixture, hash, type Fixture } from "./check.fixture.ts";

// The product fence: A's state-dir lock, A's committed retirement marker, then B's lock.
const check = ({ plan, observations }: Fixture) => checkForwardBoundary(plan, observations);

describe("forward fence: state-dir lock and retirement marker", () => {
  it("accepts both product refusal shapes, each bound to B's held lock", () => {
    const outcomes = fixture().observations.relaunches.map(({ result }) => result.outcome);
    expect(new Set(outcomes)).toEqual(
      new Set(["refused-by-legacy-fence", "refused-by-state-dir-lock"]),
    );
    expect(check(fixture()).observedRelaunchRefusals).toBe(4);
  });

  it("rejects a v2 record that relied on one continuous product fence", () => {
    const f = fixture();
    f.observations.kind = "forward-boundary-observations-v2";
    expect(() => check(f)).toThrow(/v3 forward observations/);
  });

  const failures: [string, (fixture: Fixture) => void, RegExp][] = [
    [
      "a lock held by a non-launcher at the start",
      (f) => {
        f.observations.before.lock = "a-pty";
      },
      /State-dir lock/,
    ],
    [
      "a free lock before A's drain",
      (f) => {
        f.observations.before.lock = null;
      },
      /State-dir lock/,
    ],
    [
      "a lock still held at the offline boundary",
      (f) => {
        f.observations.boundary.snapshot.lock = "a-backend";
      },
      /State-dir lock/,
    ],
    [
      "a takeover under another process's lock",
      (f) => {
        f.observations.takeover.snapshot.lock = "other-process";
      },
      /State-dir lock/,
    ],
    [
      "admission without the B writer's lock",
      (f) => {
        f.observations.admission.lock = "other-process";
      },
      /State-dir lock/,
    ],
    [
      "A's lock holder exiting before its marker committed",
      (f) => {
        f.observations.marker.seq = 4;
        f.observations.retirements[1]!.seq = 2;
      },
      /State-dir lock/,
    ],
    [
      "a marker from another A artifact",
      (f) => {
        f.observations.marker.artifactSha256 = hash("0");
      },
      /retirement marker/,
    ],
    [
      "admission on a different marker",
      (f) => {
        f.observations.admission.markerSha256 = hash("0");
      },
      /retirement marker/,
    ],
    [
      "a marker committed after the offline boundary",
      (f) => {
        f.observations.marker.seq = 6;
      },
      /retirement marker/,
    ],
    [
      "an A exit sharing the marker's recorder event",
      (f) => {
        f.observations.retirements[1]!.seq = 2;
      },
      /duplicate.*A process exit/,
    ],
    [
      "a lock refusal bound to a different holder",
      (f) => {
        f.observations.relaunches[1]!.result.lock = "a-backend";
      },
      /not bound to B's held lock/,
    ],
    [
      "a generic exit posing as a refusal",
      (f) => {
        (f.observations.relaunches[1]!.result as { outcome: string }).outcome = "exited";
      },
      /legacy fence or state-dir lock refusal/,
    ],
  ];

  it.each(failures)("rejects %s", (_name, mutate, error) => {
    const f = fixture();
    mutate(f);
    expect(() => check(f)).toThrow(error);
  });
});
