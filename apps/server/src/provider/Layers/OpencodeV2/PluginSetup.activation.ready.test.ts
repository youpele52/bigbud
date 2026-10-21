import { expect, it, vi } from "vitest";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { V2ReadinessError } from "./Orchestration.readiness.failure.ts";
import { V2ActivationDeferred } from "./PluginSetup.activation.errors.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { deferred } from "./Test.fixtures.ts";

const native = vi.hoisted(() => ({ verify: vi.fn(), manual: vi.fn(async () => undefined) }));
vi.mock("./Orchestration.readiness.ts", () => ({ verifyV2ThreadTools: native.verify }));
vi.mock("./Orchestration.readiness.manual.ts", () => ({
  readV2CompatibleManualBootstrap: native.manual,
}));
vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => ({ client: {}, close: async () => {} }),
}));

it.each(["rpc-info", "source"] as const)(
  "retains initiating %s failure through busy deferral and subsequent status without SDK contents",
  async (operation) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await makeV2ActivationJobsFixture();
    const app = await makeV2ThreadPluginFixture();
    const coordinator = new V2ThreadToolsActivation(f.settings);
    const entered = deferred<void>(),
      release = deferred<void>();
    const descriptor = {
      registrationFile: "owned-test",
      generation: "generation",
      storageIdentity: "storage",
    };
    const permit = coordinator.consent.capture();
    let job: V2OwnedActivationJob | undefined;
    native.verify.mockRejectedValue(new V2ReadinessError(operation));
    const activate = vi
      .spyOn(
        coordinator as unknown as { activate: (job: V2OwnedActivationJob) => Promise<void> },
        "activate",
      )
      .mockImplementation(async (owned) => {
        job = owned;
        owned.phase("waiting-for-idle", "Native work remains active.");
        entered.resolve();
        await release.promise;
        owned.phase("deferred", "Known work did not settle.");
        throw new Error("not a safe SDK message: https://secret.invalid?token=hidden");
      });
    try {
      const result = runV2RequestContext(
        { permit, transport: descriptor.registrationFile, intent: "execute" },
        () => {
          // An explicit setup job may already exist when foreground verification joins it.
          if (operation === "source") coordinator.requestSetup(app.artifact, descriptor, app.root);
          return coordinator.awaitReady(app.artifact, descriptor, {} as OpencodeV2Client, app.root);
        },
      ).catch((error: unknown) => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30000);
      const error = await result;
      expect(error).toBeInstanceOf(V2ActivationDeferred);
      expect((error as Error).message).toContain(`operation=${operation}; reason=unconfirmed`);
      expect((error as Error).message).toContain("Native work remains active");
      expect(coordinator.lookup(job!.id).reason).toContain(`operation=${operation}`);
      release.resolve();
      await coordinator.jobs.close();
      const status = coordinator.jobs.status(job!.id, job!.scope);
      expect(status.reason).toContain(`operation=${operation}`);
      expect(status.reason).not.toContain("secret.invalid");
      expect(status.reason).not.toContain("hidden");
    } finally {
      release.resolve();
      activate.mockRestore();
      permit.release();
      await coordinator.close();
      f.consent.close();
      await app.close();
      vi.useRealTimers();
    }
  },
);

it.each(["ready", "gate-scope-failure"] as const)(
  "unchanged valid readiness with %s never creates a setup job or observes global CLI activity",
  async (state) => {
    const f = await makeV2ActivationJobsFixture();
    const app = await makeV2ThreadPluginFixture();
    const coordinator = new V2ThreadToolsActivation(f.settings);
    const descriptor = {
      registrationFile: "owned-test",
      generation: "generation",
      storageIdentity: "storage",
    };
    const permit = coordinator.consent.capture();
    native.verify.mockResolvedValue({
      bootstrapDigest: app.artifact.artifactDigest,
      setupInstanceId: "a".repeat(32),
    });
    native.manual.mockClear();
    const setup = vi.spyOn(coordinator, "requestSetup");
    const active = vi.fn(async () => ({ unrelatedCLI: {} }));
    try {
      await runV2RequestContext(
        { permit, transport: descriptor.registrationFile, intent: "execute" },
        async () => {
          const gate = coordinator.scopeFor(app.artifact, descriptor).gate;
          if (state === "gate-scope-failure")
            vi.spyOn(gate, "verify").mockImplementation(() => {
              throw new Error(
                "V2 readiness compatibility proof scope/Location/generation changed.",
              );
            });
          const ready = coordinator.awaitReady(
            app.artifact,
            descriptor,
            { session: { active } } as unknown as OpencodeV2Client,
            app.root,
          );
          if (state === "gate-scope-failure")
            await expect(ready).rejects.toThrow("scope/Location/generation");
          else await ready;
        },
      );
      expect(setup).not.toHaveBeenCalled();
      expect(active).not.toHaveBeenCalled();
      expect(native.manual).not.toHaveBeenCalled();
    } finally {
      setup.mockRestore();
      permit.release();
      await coordinator.close();
      f.consent.close();
      await app.close();
    }
  },
);
