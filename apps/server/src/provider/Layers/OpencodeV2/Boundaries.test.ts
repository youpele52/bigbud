import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./Provider.ts";
import { appendDormantOpencodeV2 } from "../OptionalProviderComposition.ts";
import { providerWorkloadSupport, resolveProviderWorkload } from "../../providerWorkloadSupport.ts";
import {
  getProviderRemoteWorkspaceConformance,
  providerAdvertisesRemoteWorkspaceSupport,
} from "../../providerRemoteWorkspaceConformance.ts";

describe("dormant V2 capability and composition boundaries", () => {
  it("keeps dormant execution unavailable without model authentication, continuation, or native steering", async () => {
    const adapter = makeDormantOpencodeV2Adapter();
    const snapshot = await Effect.runPromise(makeDormantOpencodeV2Provider().getSnapshot);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.models).toEqual([]);
    expect(snapshot.supportsSteer).toBe(false);
    expect(snapshot.turnControl).toEqual(adapter.capabilities.turnControl);
    expect(adapter.capabilities).toMatchObject({
      sessionRecovery: "unsupported",
      conversationRewind: "unsupported",
      conversationFork: "unsupported",
    });
    expect(adapter.steerTurn).toBeUndefined();
    expect(adapter.mcp).toBeUndefined();
    expect(providerWorkloadSupport("opencodeV2")).toEqual({
      interactive: true,
      learning: false,
      unattendedTextGeneration: false,
      usageAccounting: true,
    });
    expect(providerAdvertisesRemoteWorkspaceSupport(snapshot)).toBe(false);
  });
  it("rejects lifecycle mutations and absent identity before any dispatch", async () => {
    const adapter = makeDormantOpencodeV2Adapter();
    const thread = ThreadId.makeUnsafe("fixture");
    for (const operation of [
      adapter
        .startSession({
          threadId: thread,
          provider: "opencodeV2",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.asVoid),
      adapter.sendTurn({ threadId: thread, input: "same text" }).pipe(Effect.asVoid),
      adapter.rollbackThread(thread, 1).pipe(Effect.asVoid),
      adapter.readThread(thread).pipe(Effect.asVoid),
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(operation))).toBe(true);
    }
    expect(await Effect.runPromise(adapter.listSessions())).toEqual([]);
    expect(await Effect.runPromise(adapter.hasSession(thread))).toBe(false);
    await Effect.runPromise(adapter.stopAll());
  });
  it("aggregates optional registrations without routing work to the disabled dormant snapshot", async () => {
    const v2 = appendDormantOpencodeV2([], true)[0]!;
    expect(v2.capabilities.supportsLocalRuntimeRemoteWorkspace).toBe(false);
    const cliProxy = { ...v2, provider: "cliProxy" as const };
    const existing = [cliProxy];
    expect(appendDormantOpencodeV2(existing, false)).toBe(existing);
    expect(
      appendDormantOpencodeV2(existing, true).map((registration) => registration.provider),
    ).toEqual(["cliProxy", "opencodeV2"]);
    expect(() => appendDormantOpencodeV2([v2], true)).toThrow("already registered");
    expect(
      resolveProviderWorkload({
        requested: { provider: "opencodeV2", model: "fixture" },
        workload: "interactive",
        availableProviders: [await Effect.runPromise(v2.providerService.getSnapshot)],
      }).action,
    ).toBe("reject");
  });
  it("routes configured preview work without admitting public learning or migrating accounting", () => {
    expect(getProviderRemoteWorkspaceConformance("opencodeV2")).toMatchObject({
      backend: "agent-runtime",
      supportsLocalRuntimeRemoteWorkspace: true,
    });
    const requested = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "fixture",
    } as const;
    expect(
      resolveProviderWorkload({
        requested,
        workload: "interactive",
        availableProviderKinds: ["opencodeV2"],
      }),
    ).toEqual({ requested, actual: requested, action: "use-requested", reason: null });
    for (const workload of ["learning", "usageAccounting"] as const) {
      expect(
        resolveProviderWorkload({ requested, workload, availableProviderKinds: ["codex"] }),
      ).toMatchObject({ requested, actual: null, action: "reject" });
    }
  });
});
