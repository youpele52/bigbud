import { realpath } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import * as storage from "./Orchestration.storage.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";
import { observeV2OwnedFamily } from "./Runtime.family.observe.ts";
import { shouldPollV2Runtime } from "./Runtime.settlement.ts";
import { deferred } from "./Test.fixtures.ts";
import { attachV2OwnedFamily } from "./Runtime.family.ts";
import { retireV2FailedStart } from "./Runtime.start.failure.ts";

it.each(["windows", "ENOSPC"])(
  "empty-family %s persistence failure still reaches root cancellation and teardown, retaining uncertainty",
  async (failure) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, expectRetainedClose }) => {
      const root = await realpath(runtime.options.config.profileRoot);
      Object.assign(runtime.options, { nativeSubagents: { stateDirectory: root } });
      const threadId = ThreadId.makeUnsafe(`empty-family-${failure}`);
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      });
      const owner = runtime.get(threadId);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const write =
        failure === "ENOSPC"
          ? vi
              .spyOn(storage, "writeV2ThreadPrivateFile")
              .mockRejectedValue(new Error("ENOSPC injected"))
          : undefined;
      if (failure === "windows")
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        await expect(runtime.stop(threadId)).rejects.toThrow();
        expect(owner.family!.isFenced).toBe(true);
        expect(owner.family!.persistenceUncertain).toBe(true);
        expect(owner.stopped).toBe(true);
        // Uncertain cleanup keeps the exact owner and binding quarantine; only proof releases them.
        expect(runtime.sessions.get(threadId)).toBe(owner);
        expect(runtime.teardown.has(threadId)).toBe(true);
        expect(owner.executionBlocked).toContain("unconfirmed");
        expect(
          http.calls.some((call) => call.pathname === `/api/session/${owner.native.id}/interrupt`),
        ).toBe(true);
        await expect(owner.family!.authorizeAdmission("new", "fingerprint")).rejects.toThrow(
          "persistence",
        );
        // Journal uncertainty cannot be cleared in-process, so shutdown must still report it.
        expectRetainedClose("persistence remains unconfirmed");
      } finally {
        Object.defineProperty(process, "platform", platform);
        write?.mockRestore();
      }
    });
  },
);

it("journal exhaustion cannot prevent cancellation of exact owned descendants or root", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, finish, expectRetainedClose }) => {
    await launch("ses_journal_child");
    http.sessions.set("ses_unrelated", { ...owner.native, id: "ses_unrelated" });
    const fetch = http.fetch.bind(http);
    const native = vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      const result = await fetch(url, init);
      if (new URL(url).pathname === "/api/session/ses_journal_child/interrupt")
        finish("ses_journal_child");
      return result;
    });
    const write = vi
      .spyOn(storage, "writeV2ThreadPrivateFile")
      .mockRejectedValue(new Error("ENOSPC injected"));
    try {
      await expect(runtime.stop(owner.threadId)).rejects.toThrow();
      const cancelled = http.calls
        .filter((call) => call.pathname.endsWith("/interrupt"))
        .map((call) => call.pathname);
      expect(cancelled).toContain(`/api/session/${owner.native.id}/interrupt`);
      expect(cancelled).toContain("/api/session/ses_journal_child/interrupt");
      expect(cancelled).not.toContain("/api/session/ses_unrelated/interrupt");
      expect(owner.family!.persistenceUncertain).toBe(true);
      expect(owner.family!.live).toBe(true);
      // Exhausted journal ownership stays retained through shutdown rather than being released.
      expectRetainedClose("V2 descendant Stop remains unconfirmed");
    } finally {
      write.mockRestore();
      native.mockRestore();
    }
  });
});

it("idle child with queued input stays owned; a proven newer wake restores terminal ownership before routing permission", async () => {
  await withV2OwnedFamily(async ({ runtime, owner, http, launch, finish, events }) => {
    const id = "ses_waking";
    await launch(id);
    // Foreground completion can physically drain; background continuations cannot.
    const child = owner.family!.child(id)!;
    owner.family = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
      rootId: owner.native.id,
      storageIdentity: owner.storageIdentity,
      threadId: owner.threadId,
    });
    await owner.family.enroll({ ...child, background: false });
    finish(id);
    http.inbox.set(id, [
      {
        id: "msg_queued",
        sessionID: id,
        type: "user",
        delivery: "queue",
        time: { created: 7 },
        payload: { text: "queued" },
      },
    ]);
    await observeV2OwnedFamily(runtime, owner, () => {});
    expect(owner.family.child(id)!.state).toBe("enrolled");
    http.inbox.set(id, []);
    await observeV2OwnedFamily(runtime, owner, () => {});
    expect(owner.family.child(id)!.state).toBe("terminal");
    http.sessions.set(id, { ...http.sessions.get(id)!, time: { created: 1, updated: 8, idle: 6 } });
    http.permissions.set(id, [
      { id: "per_wake", sessionID: id, action: "read", resources: ["offline.txt"] },
    ]);
    await observeV2OwnedFamily(runtime, owner, () => {});
    expect(owner.family.child(id)!.state).toBe("enrolled");
    expect(shouldPollV2Runtime(owner)).toBe(true);
    const request = events.find(
      (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-child:"),
    );
    expect(request).toBeDefined();
    await runtime.respondPermission(owner.threadId, request!.requestId!, "accept");
    expect(
      http.calls.some((call) => call.pathname === `/api/session/${id}/permission/per_wake/reply`),
    ).toBe(true);
  });
});

it.each([false, true])(
  "guard disposal is awaited after successful retirement (startup failure=%s)",
  async (failedStart) => {
    await withV2OwnedFamily(async ({ runtime, owner }) => {
      const pending = deferred<void>();
      const dispose = vi.fn(() => pending.promise);
      owner.detachSubagentGuard = dispose;
      await expect(attachV2OwnedFamily(runtime, owner)).rejects.toThrow("already attached");
      let settled = false;
      const stop = (
        failedStart ? retireV2FailedStart(runtime, owner) : runtime.stop(owner.threadId)
      ).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      pending.resolve();
      await stop;
      expect(owner.detachSubagentGuard).toBeUndefined();
    });
  },
);

it("uncertain cleanup retains guard and quarantine rather than disposing failclosed authority", async () => {
  await withV2OwnedFamily(async ({ runtime, owner, http, expectRetainedClose }) => {
    const dispose = vi.fn(async () => {});
    owner.detachSubagentGuard = dispose;
    http.failInterrupt = true;
    await expect(runtime.stop(owner.threadId)).rejects.toThrow();
    expect(dispose).not.toHaveBeenCalled();
    expect(owner.detachSubagentGuard).toBe(dispose);
    expect(owner.stopped).toBe(true);
    http.failInterrupt = false;
    // Teardown never repeats native cleanup: shutdown reports the retained failure, guard intact.
    expectRetainedClose("session.interrupt failed");
  });
});

it("actual startup failure after guard attachment cancels the registered root before awaiting guard disposal", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const pending = deferred<void>();
    const dispose = vi.fn(() => pending.promise);
    let nativeId = "";
    Object.assign(runtime.options, {
      enableLocalTools: true,
      nativeSubagents: {
        stateDirectory: await realpath(runtime.options.config.profileRoot),
        qualification: {
          assertCurrent: () => {},
          attach: async (owner: ReturnType<typeof runtime.get>) => {
            nativeId = owner.native.id;
            return dispose;
          },
        },
      },
      codingBridge: {
        attach: async () => {
          throw new Error("injected post-guard startup failure");
        },
      },
    });
    const start = runtime.start({
      threadId: ThreadId.makeUnsafe("failed-start-guard"),
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const result = start.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(
        http.calls.some((call) => call.pathname === `/api/session/${nativeId}/interrupt`),
      ).toBe(true);
    } finally {
      pending.resolve();
    }
    expect(await result).toBeInstanceOf(Error);
    expect(runtime.sessions.size).toBe(0);
  });
});
