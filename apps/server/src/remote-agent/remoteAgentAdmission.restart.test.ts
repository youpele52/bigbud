import { describe, expect, it } from "vitest";
import { failedInstallFixture } from "./remoteAgentAdmission.restart.fixtures.ts";
import { fixture } from "./remoteAgentAdmission.fixtures.ts";
import { reconcileFailedRemoteAgentAdmission } from "./remoteAgentAdmission.reconcile.ts";

describe("failed install followed by advised managed restart", () => {
  it("settles the actual last failed candidate without revisiting exhausted fallback builds", async () => {
    const f = await failedInstallFixture("exited:137", true);
    expect(await f.install()).toMatchObject({ outcome: "failed" });
    expect(f.connect.mock.calls.map(([, runtime]) => runtime.generation)).toEqual([
      "g3",
      "g2",
      "g1",
    ]);
    const state = await f.control.registry.read();
    expect(state.admissions).toEqual(f.initial.admissions);
    expect(state.admissionRetirements).toContainEqual(
      expect.objectContaining({
        id: "failed",
        buildId: f.initial.builds[0]!.id,
        outcome: "rejected",
      }),
    );
    expect(state.pins).toEqual([
      ...f.initial.pins,
      { owner: "activation:failed:g3", buildId: f.initial.builds[2]!.id },
      { owner: "activation:failed:g2", buildId: f.initial.current },
    ]);
    expect(await f.restart.restart(f.request)).toMatchObject({ phase: "ready" });
    expect((await f.control.registry.read()).pins).toEqual(
      expect.arrayContaining(state.pins.filter((pin) => pin.owner !== "connection:existing")),
    );
  });

  it("reevaluates a retained request only on its recorded candidate even with other ready metadata", async () => {
    const f = await failedInstallFixture("unknown", true);
    await f.install();
    const before = await f.control.registry.read();
    expect(before.admissions.find((entry) => entry.id === "failed")?.buildId).toBe(
      f.initial.builds[0]!.id,
    );
    f.connect.mockClear();
    f.run.mockResolvedValue("exited:137");
    await expect(f.admission.fresh("failed-install", "failed")).rejects.toMatchObject({
      code: "ADMISSION_UNAVAILABLE",
    });
    expect(f.connect.mock.calls.map(([, runtime]) => runtime.generation)).toEqual(["g1"]);
    expect((await f.control.registry.read()).admissionRetirements).toContainEqual(
      expect.objectContaining({
        id: "failed",
        buildId: f.initial.builds[0]!.id,
        outcome: "rejected",
      }),
    );
  });
  it("creates no admission or pin while another caller owns restart", async () => {
    const f = await failedInstallFixture();
    const before = await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      restartReservations: [
        {
          id: "concurrent",
          buildId: state.current!,
          generation: "g2",
          expectedEpoch: "epoch-g2",
          phase: "reserved",
        },
      ],
    }));
    expect(await f.install()).toMatchObject({ outcome: "failed" });
    expect(await f.control.registry.read()).toEqual(before);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["exited:137", "prior-boot-dead"])(
    "settles only the failed admission after %s proof and permits explicit restart",
    async (observation) => {
      const f = await failedInstallFixture(observation);
      const installed = await f.install();
      expect(installed).toMatchObject({ state: "completed", outcome: "failed" });
      expect(installed?.message).toContain("managed service restart");
      const failed = await f.control.registry.read();
      expect(failed.admissions).toEqual(f.initial.admissions);
      expect(failed.admissionRetirements).toContainEqual(
        expect.objectContaining({ id: "failed", epoch: "", outcome: "rejected" }),
      );
      expect(failed.pins).toEqual(f.initial.pins);
      expect(failed.launches).toEqual(f.initial.launches);
      expect(failed.currentConnectionId).toBe("existing");
      expect(f.run.mock.calls).toHaveLength(1);
      expect(f.run.mock.calls[0]?.[0]).not.toContain("--supervisor");
      const result = await f.restart.restart(f.request);
      expect(result).toMatchObject({ phase: "ready", replacementEpoch: "replacement-epoch" });
      expect(f.bindReplacement).toHaveBeenCalledOnce();
      expect(f.reconnect).toHaveBeenCalledOnce();
      const ready = await f.control.registry.read();
      expect(ready.pins).toContainEqual({ owner: "terminal:retained", buildId: f.initial.current });
      await expect(f.admission.fresh("failed-install", "failed")).rejects.toMatchObject({
        code: "ADMISSION_RETIRED",
      });
      expect(f.frames).toEqual([]);
    },
  );

  it.each(["live", "ready", "unknown", "exited:garbage", "exited:137\nready"])(
    "preserves the unresolved admission and pins for %s evidence",
    async (observation) => {
      const f = await failedInstallFixture(observation);
      await f.install();
      const before = await f.control.registry.read();
      expect(before.admissions).toContainEqual(
        expect.objectContaining({ id: "failed", phase: "prepared", epoch: "" }),
      );
      expect(before.pins).toContainEqual({
        owner: "activation:failed:g2",
        buildId: f.initial.current,
      });
      await expect(f.restart.restart(f.request)).rejects.toThrow("unresolved or mismatched");
      expect((await f.control.registry.read()).pins).toEqual(before.pins);
      expect(f.bindReplacement).not.toHaveBeenCalled();
    },
  );

  it.each(["launch", "admission", "pin", "restart", "other-admission"])(
    "retains all evidence when %s changes during death observation",
    async (change) => {
      const f = await failedInstallFixture();
      let observedState: Awaited<ReturnType<typeof f.control.registry.read>> | undefined;
      f.run.mockImplementation(async () => {
        observedState = await f.control.registry.update((state) => ({
          ...state,
          revision: state.revision + 1,
          ...(change === "launch"
            ? { launches: state.launches.map((entry) => ({ ...entry, attemptId: "concurrent" })) }
            : change === "admission"
              ? {
                  admissions: state.admissions.map((entry) =>
                    entry.id === "failed" ? { ...entry, warning: "concurrent owner" } : entry,
                  ),
                }
              : change === "pin"
                ? { pins: [...state.pins, { owner: "connection:failed", buildId: state.current! }] }
                : change === "other-admission"
                  ? {
                      admissions: [
                        ...state.admissions,
                        {
                          id: "concurrent",
                          buildId: state.current!,
                          phase: "prepared" as const,
                          epoch: "",
                        },
                      ],
                    }
                  : {
                      restartReservations: [
                        {
                          id: "concurrent",
                          buildId: state.current!,
                          generation: "g2",
                          expectedEpoch: "epoch-g2",
                          phase: "reserved" as const,
                        },
                      ],
                    }),
        }));
        return "exited:137";
      });
      expect(await f.install()).toMatchObject({ outcome: "failed" });
      expect(observedState).toBeDefined();
      expect(await f.control.registry.read()).toEqual(observedState);
      expect(observedState?.pins).toContainEqual({
        owner: "activation:failed:g2",
        buildId: f.initial.current,
      });
    },
  );

  it.each([
    "missing-attempt",
    "missing-pin",
    "connection-pin",
    "mismatched-pin",
    "active-restart",
    "missing-epoch",
  ])("refuses reconciliation of %s without probing or changing pins", async (condition) => {
    const f = await failedInstallFixture("unknown");
    await f.install();
    const before = await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      ...(condition === "missing-attempt"
        ? { launches: state.launches.map(({ attemptId: _attempt, ...entry }) => entry) }
        : condition === "missing-pin"
          ? { pins: state.pins.filter((pin) => !pin.owner.startsWith("activation:")) }
          : condition === "connection-pin"
            ? { pins: [...state.pins, { owner: "connection:failed", buildId: state.current! }] }
            : condition === "mismatched-pin"
              ? {
                  pins: state.pins.map((pin) =>
                    pin.owner.startsWith("activation:")
                      ? { ...pin, buildId: state.builds[0]!.id }
                      : pin,
                  ),
                }
              : condition === "missing-epoch"
                ? {
                    admissions: state.admissions.filter((entry) => entry.id !== "existing"),
                    currentConnectionId: null,
                    launches: state.launches.map((entry) => ({
                      ...entry,
                      phase: "reserved" as const,
                      epoch: "",
                    })),
                  }
                : {
                    restartReservations: [
                      {
                        id: "concurrent",
                        buildId: state.current!,
                        generation: "g2",
                        expectedEpoch: "epoch-g2",
                        phase: "reserved" as const,
                      },
                    ],
                  }),
    }));
    f.run.mockClear();
    await reconcileFailedRemoteAgentAdmission(f.control, before, "failed");
    expect(await f.control.registry.read()).toEqual(before);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("retains the unresolved admission when its death probe fails", async () => {
    const f = await failedInstallFixture();
    f.run.mockRejectedValue(new Error("SSH lost"));
    expect(await f.install()).toMatchObject({ outcome: "failed" });
    expect((await f.control.registry.read()).admissions).toContainEqual(
      expect.objectContaining({ id: "failed", phase: "prepared" }),
    );
  });

  it("re-evaluates a retained failed request without implicitly launching a replacement", async () => {
    const f = await failedInstallFixture("unknown");
    await f.install();
    f.run.mockResolvedValue("exited:137");
    await expect(f.admission.fresh("failed-install", "failed")).rejects.toMatchObject({
      code: "ADMISSION_UNAVAILABLE",
    });
    expect((await f.control.registry.read()).admissions).toEqual(f.initial.admissions);
    expect(f.run.mock.calls.every(([command]) => !command.includes("--supervisor"))).toBe(true);
  });

  it("does not recreate a connection pin if an admission is retired before publication", async () => {
    const f = fixture();
    const update = f.control.registry.update;
    f.control.registry.update = async (transition) =>
      update((state) => {
        const next = transition(state);
        if (next.currentConnectionId !== "racing" || state.currentConnectionId === "racing")
          return next;
        const entry = state.admissions.find((item) => item.id === "racing")!;
        const concurrent = {
          ...state,
          revision: state.revision + 1,
          admissions: state.admissions.filter((item) => item.id !== "racing"),
          admissionRetirements: [
            ...(state.admissionRetirements ?? []),
            { ...entry, outcome: "rejected" as const },
          ],
        };
        // Registry CAS retries the transition against a winner that retired this exact request.
        expect(() => transition(concurrent)).toThrow("Admission changed concurrently");
        throw new Error("concurrent retirement");
      });
    await expect(f.admission.fresh("publication-race", "racing")).rejects.toThrow();
    expect(
      (await f.control.registry.read()).pins.some((pin) => pin.owner === "connection:racing"),
    ).toBe(false);
  });
});
