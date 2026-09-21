import { describe, expect, it, vi } from "vitest";
import { fixture } from "./remoteAgentAdmission.fixtures.ts";
import { remoteAgentRuntimeSummary } from "./remoteAgentStatus.ts";
import { statusFromState } from "./remoteAgentUpdate.status.ts";

describe("connection update warnings", () => {
  it("selects only the healthy stable runtime after failed update preparation and preserves warning on replay", async () => {
    const f = fixture();
    const before = await f.control.registry.read();
    const preparation = {
      requestedBuildId: before.pending!,
      requestedVersion: "0.2.209",
      warning: "Candidate readiness timed out.",
    };
    const connected = await f.admission.fresh("update-failure", "warning", preparation);
    expect(connected.state.current).toBe(before.current);
    expect(connected.state.pending).toBe(before.pending);
    expect(remoteAgentRuntimeSummary(connected.state)).toMatchObject({
      outcome: "fallback",
      currentVersion: "0.2.207",
      ...preparation,
    });
    expect(
      statusFromState("update-failure", "/tmp/agent", connected.state, false, "warning").reason,
    ).toBe(preparation.warning);
    const replayed = await f.admission.fresh("update-failure", "warning", {
      requestedVersion: "0.2.210",
      warning: "A different later failure.",
    });
    expect(remoteAgentRuntimeSummary(replayed.state)).toEqual(
      remoteAgentRuntimeSummary(connected.state),
    );
    expect(f.connect.mock.calls.every(([, runtime]) => runtime.generation === "g2")).toBe(true);
  });

  it("records unavailable update discovery without inventing a requested version or build", async () => {
    const f = fixture();
    const result = await f.admission.fresh("source-offline", "offline", {
      warning: "Release metadata is unavailable.",
    });
    const summary = remoteAgentRuntimeSummary(result.state);
    expect(summary).toMatchObject({
      outcome: "fallback",
      warning: "Release metadata is unavailable.",
    });
    expect(summary.requestedVersion).toBeUndefined();
    expect(summary.requestedBuildId).toBeUndefined();
  });

  it("does not bless an unauthenticated legacy runtime or select pending when fallback is required", async () => {
    const f = fixture();
    await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      builds: state.builds.map((build) =>
        build.id === state.current ? { ...build, authenticated: false } : build,
      ),
    }));
    await expect(
      f.admission.fresh("untrusted", "blocked", { warning: "Download failed." }),
    ).rejects.toMatchObject({ code: "ADMISSION_UNAVAILABLE" });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("retains the warning through a lost commit response and history retirement", async () => {
    const f = fixture();
    const update = f.control.registry.update;
    let lost = false;
    vi.spyOn(f.control.registry, "update").mockImplementation(async (transition) => {
      const state = await update(transition);
      if (!lost && state.currentConnectionId === "lost-warning") {
        lost = true;
        throw new Error("Commit response lost.");
      }
      return state;
    });
    const preparation = { warning: "Download failed.", requestedVersion: "0.2.209" };
    await expect(f.admission.fresh("lost-warning", "lost-warning", preparation)).rejects.toThrow();
    const recovered = await f.admission.fresh("lost-warning", "lost-warning");
    expect(remoteAgentRuntimeSummary(recovered.state)).toMatchObject({
      ...preparation,
      outcome: "fallback",
    });
    const next = await f.admission.fresh("lost-warning", "next");
    expect(
      next.state.admissionRetirements?.find((entry) => entry.id === "lost-warning"),
    ).toMatchObject({ ...preparation, outcome: "fallback" });
    expect(
      statusFromState("lost-warning", "/tmp/agent", next.state, false, "lost-warning").reason,
    ).toBe(preparation.warning);
  });
});
