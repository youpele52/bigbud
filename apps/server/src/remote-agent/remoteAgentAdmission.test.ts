import { describe, expect, it, vi } from "vitest";
import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import { build, fixture } from "./remoteAgentAdmission.fixtures.ts";

describe("explicit production remote admission", () => {
  it("reconciles a lost coherent admission CAS reply using the same connection without repromotion", async () => {
    const f = fixture();
    const update = f.control.registry.update;
    let lost = false;
    vi.spyOn(f.control.registry, "update").mockImplementation(async (transition) => {
      const state = await update(transition);
      if (!lost && state.currentConnectionId === "lost-commit") {
        lost = true;
        throw new Error("CAS reply lost after durable commit");
      }
      return state;
    });
    await expect(f.admission.fresh("cas-target", "lost-commit")).rejects.toThrow();
    const committed = await f.control.registry.read();
    expect(committed.currentConnectionId).toBe("lost-commit");
    const recovered = await f.admission.fresh("cas-target", "lost-commit");
    expect(recovered.state.current).toBe(committed.current);
    expect(recovered.state.promotionSequence).toBe(committed.promotionSequence);
    expect((await f.admission.resolveBinding("cas-target"))?.runtime.generation).toBe("g3");
  });
  it("atomically publishes successive builds and a previously healthy fallback", async () => {
    const f = fixture();
    await f.admission.fresh("successive", "first");
    const fourth = build(4, false);
    await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      builds: [...state.builds, fourth],
      pending: fourth.id,
      launches: [
        ...state.launches,
        {
          id: fourth.runtime.generation,
          buildId: fourth.id,
          phase: "ready" as const,
          epoch: `epoch-${fourth.runtime.generation}`,
        },
      ],
      updates: [
        ...state.updates,
        {
          requestId: `update-${fourth.runtime.sha256}`,
          buildId: fourth.id,
          phase: "ready-for-reconnect" as const,
          outcome: "ready" as const,
          epoch: `epoch-${fourth.runtime.generation}`,
        },
      ],
    }));
    await f.admission.fresh("successive", "second");
    expect((await f.control.registry.read()).current).toBe(fourth.id);
    await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      pending: state.builds[2]!.id,
    }));
    const fallback = await f.admission.fresh("successive", "third");
    expect(fallback.state.current).toBe(fallback.state.builds[2]!.id);
    expect(fallback.state.currentConnectionId).toBe("third");
  });
  it("does not consume pending during ordinary resolution and promotes only after readiness", async () => {
    const f = fixture();
    expect((await f.admission.resolveBinding("target"))?.runtime.generation).toBe("g2");
    expect(f.connect).not.toHaveBeenCalled();
    const result = await f.admission.fresh("target", "fresh-request");
    expect(result.state.builds[2]?.health).toBe("healthy");
    expect(result.state.promotionSequence).toBe(3);
    expect(result.state.pending).toBeNull();
    expect(f.frames).toEqual(["diagnosticRequest"]);
    await f.admission.fresh("target", "fresh-request");
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("does not select a staged pending build before durable readiness", async () => {
    const f = fixture();
    await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      updates: state.updates.map((update) => ({ ...update, phase: "checking" as const })),
    }));

    const result = await f.admission.fresh("target", "staged-pending");

    expect(result.state.current).toBe(result.state.builds[1]?.id);
    expect(result.state.pending).toBe(result.state.builds[2]?.id);
    expect(f.connect).toHaveBeenCalledWith("target", result.state.builds[1]?.runtime);
  });

  it.each(["identity", "network"] as const)(
    "uses verified fallback without user dispatch after %s failure",
    async (failure) => {
      const f = fixture(failure);
      const result = await f.admission.fresh("target", "fallback-request");
      expect(result.state.current).toBe(result.state.builds[1]?.id);
      expect(result.state.builds[2]?.health).toBe(
        failure === "identity" ? "quarantined" : "staged",
      );
      expect(result.state.promotionSequence).toBe(2);
      expect(result.state.pins.some((pin) => pin.buildId === result.state.builds[2]?.id)).toBe(
        true,
      );
      expect(f.frames).toEqual(["diagnosticRequest"]);
    },
  );

  it("concurrent admission retries cannot occupy duplicate healthy slots", async () => {
    const f = fixture();
    await Promise.all([
      f.admission.fresh("target", "same-request"),
      f.admission.fresh("target", "same-request"),
    ]);
    const state = await f.control.registry.read();
    expect(state.promotionSequence).toBe(3);
    expect(state.admissions).toHaveLength(1);
    expect(state.pins.filter((pin) => pin.owner === "connection:same-request")).toHaveLength(1);
  });

  it("releases completed attempt pins during admission churn while retaining the live connection", async () => {
    const f = fixture();
    for (let index = 0; index < 80; index++)
      await f.admission.fresh(`churn-${index}`, `churn-${index}`);
    const state = await f.control.registry.read();
    expect(state.pins.filter((pin) => pin.owner.startsWith("activation:")).length).toBe(0);
    expect(state.pins.filter((pin) => pin.owner.startsWith("connection:"))).toEqual([
      expect.objectContaining({ owner: `connection:churn-${79}` }),
    ]);
    expect(state.admissions.length).toBeLessThanOrEqual(64);
  });
  it("rejects a pruned request instead of consuming a newer pending build", async () => {
    const f = fixture();
    for (let index = 0; index < 80; index++)
      await f.admission.fresh(`retry-${index}`, `retry-${index}`);
    const before = await f.control.registry.read();
    const retired = before.admissionRetirements?.find((entry) => entry.id === "retry-0");
    expect(retired).toBeDefined();
    const pending = build(4, false);
    await f.control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      builds: [...state.builds, pending],
      pending: pending.id,
    }));
    await expect(f.admission.fresh("retry-target", "retry-0")).rejects.toMatchObject({
      code: "ADMISSION_RETIRED",
    });
    const after = await f.control.registry.read();
    expect(after.currentConnectionId).not.toBe("retry-0");
    expect(after.pending).toBe(pending.id);
    expect(
      f.connect.mock.calls.some(([, runtime]) => runtime.generation === pending.runtime.generation),
    ).toBe(false);
  });
  it("uses the production default durable-reference binding and releases only when it says false", async () => {
    const f = fixture();
    const hasDurableReferences = vi.fn(async () => false);
    configureRemoteAgentOwners({
      getBinding: async () => undefined,
      bindConnection: async () => undefined,
      hasDurableReferences,
    } as never);
    const admission = makeRemoteAgentAdmission({
      control: async () => f.control,
      connect: f.connect,
    });

    await admission.fresh("default-bindings", "first");
    await admission.fresh("default-bindings", "second");

    expect(hasDurableReferences).toHaveBeenCalledWith("default-bindings", "first");
    expect((await f.control.registry.read()).pins).not.toContainEqual(
      expect.objectContaining({ owner: "connection:first" }),
    );
  });
  it("retains a superseded connection pin when durable references are unknown", async () => {
    const f = fixture(undefined, "unknown");
    await f.admission.fresh("unknown-references", "first");
    await f.admission.fresh("unknown-references", "second");
    expect((await f.control.registry.read()).pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "connection:first" }),
        expect.objectContaining({ owner: "connection:second" }),
      ]),
    );
  });

  it("retains the activation pin when local connection publication fails after promotion", async () => {
    const f = fixture("binding");
    await expect(f.admission.fresh("publication-failure", "failed-publication")).rejects.toThrow(
      "local connection publication failed",
    );
    const state = await f.control.registry.read();
    expect(state.pins).toEqual([
      expect.objectContaining({ owner: "activation:failed-publication:g3" }),
      expect.objectContaining({ owner: "connection:failed-publication" }),
    ]);
  });
});
