import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { withoutCompletedRetirementClaims } from "./remoteAgentInstall.registry.orphans.ts";
import { pruneRemoteAgentHistory } from "./remoteAgentInstall.registry.admission.ts";
import { reserveRemoteAgentStage } from "./remoteAgentInstall.registry.transitions.ts";

// Exact disposable-host registry from p4val8/t2b, not a reduced synthetic reconstruction.
// Source: /tmp/bigbud-p4val8-20261113224835/fixture/t2b-post-registry.json.
function recorded() {
  return parseRemoteAgentRegistry(
    readFileSync(new URL("./fixtures/retirement-orphan.p4val8.json", import.meta.url), "utf8"),
  );
}
it("repairs the recorded post-tombstone orphan while preserving unrelated update evidence", () => {
  const state = recorded();
  const orphan = state.updates.find((row) => row.requestId.startsWith("retire-replace-"))!;
  expect(state.retirementReservations).toEqual([]);
  expect(state.builds.find((build) => build.id === orphan.buildId)?.binary).toBe("absent");
  expect(withoutCompletedRetirementClaims(state)).toEqual(
    state.updates.filter((row) => row !== orphan),
  );
  const pruned = pruneRemoteAgentHistory(state);
  expect(pruned.revision).toBe(state.revision + 1);
  expect(pruned.updates.find((row) => row.phase === "checking")).toEqual(
    state.updates.find((row) => row.phase === "checking"),
  );
  expect(pruned.updates.some((row) => row.requestId === orphan.requestId)).toBe(false);
});
it("repairs before re-stage creates fresh evidence, but never repairs an already present build", () => {
  const state = recorded();
  const build = state.builds.find((row) => row.binary === "absent")!;
  const staged = reserveRemoteAgentStage(state, "recorded-restage", build);
  expect(staged.revision).toBe(state.revision + 1);
  expect(staged.updates.some((row) => row.requestId.startsWith("retire-replace-"))).toBe(false);
  expect(staged.stages.some((row) => row.id === "recorded-restage")).toBe(true);
  const protectedState = {
    ...state,
    builds: state.builds.map((row) =>
      row.id === build.id ? Object.assign({}, row, { binary: "present" as const }) : row,
    ),
  };
  expect(withoutCompletedRetirementClaims(protectedState)).toBe(protectedState.updates);
});
