import { expect, it } from "vitest";
import { bootFixture } from "./localSupervisorService.boot.test.helpers.ts";
import { serviceConfigFixture } from "./localSupervisorService.test.helpers.ts";
import { managedLeaseRuntimeSelection } from "./localSupervisorService.leaseChannel.policy.ts";
function fixture() {
  const f = bootFixture();
  const config = {
    ...serviceConfigFixture,
    rust_binary: f.selected.binaryPath,
    rust_sha256: f.selected.sha256,
    rust_state: f.selected.statePath,
  };
  const binding = { connectionId: "original", runtime: f.selected, expectedEpoch: "42" };
  return { ...f, config, binding };
}
it("projects an immutable runtime only from matching canonical signed admission and SQL", () => {
  const f = fixture();
  const result = managedLeaseRuntimeSelection(f.state(), f.binding, f.config);
  expect(result).toEqual(f.binding);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.runtime)).toBe(true);
  f.selected.buildDigest = "caller mutation";
  expect(result.runtime.buildDigest).toBe("digest");
});
it("refuses unsigned/quarantined/missing binaries and in-flight restart or retirement", () => {
  const f = fixture(),
    state = f.state(),
    build = state.builds[0]!;
  for (const changed of [
    { ...build, authenticated: false },
    { ...build, health: "quarantined" as const },
    { ...build, binary: "absent" as const },
  ])
    expect(() =>
      managedLeaseRuntimeSelection({ ...state, builds: [changed] }, f.binding, f.config),
    ).toThrow();
  expect(() =>
    managedLeaseRuntimeSelection(
      {
        ...state,
        restartReservations: [
          {
            id: "held",
            buildId: build.id,
            generation: f.selected.generation,
            expectedEpoch: "42",
            phase: "stopping",
          },
        ],
      },
      f.binding,
      f.config,
    ),
  ).toThrow();
  expect(() =>
    managedLeaseRuntimeSelection(
      {
        ...state,
        retirementReservations: [
          { id: "held", buildId: build.id, generation: f.selected.generation, phase: "reserved" },
        ],
      },
      f.binding,
      f.config,
    ),
  ).toThrow();
});
it("rejects SQL epoch/connection/runtime disagreement and a different config launcher", () => {
  const f = fixture();
  for (const binding of [
    undefined,
    { ...f.binding, connectionId: "old" },
    { ...f.binding, expectedEpoch: "old" },
    { ...f.binding, runtime: { ...f.selected, buildDigest: "different" } },
  ])
    expect(() => managedLeaseRuntimeSelection(f.state(), binding, f.config)).toThrow();
  for (const field of ["rust_binary", "rust_sha256", "rust_state"] as const)
    expect(() =>
      managedLeaseRuntimeSelection(f.state(), f.binding, { ...f.config, [field]: "different" }),
    ).toThrow();
});
