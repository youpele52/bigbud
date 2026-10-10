import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { V2StartAttempt } from "./Runtime.start.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("rejects a public-only model before creating native history or acquiring mutation quarantine", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    http.modelUnavailable = true;
    const threadId = ThreadId.makeUnsafe("setup-new-session");
    await expect(
      runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: { ...modelSelection, model: "not-connected" },
      }),
    ).rejects.toThrow("Connect/configure");
    expect(http.calls.filter(({ method }) => method !== "GET")).toEqual([]);
    expect(http.sessions.size).toBe(0);
    expect(await Effect.runPromise(runtime.options.journal.listBound(threadId, 10))).toEqual([]);
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});

for (const change of ["settings", "cancel", "process"] as const)
  it(`rechecks startup ${change} after awaited catalog preflight without creating history`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      let enabled = true;
      Object.assign(runtime.options, {
        authorizeExecution: async () => {
          if (!enabled) throw new Error("settings changed during catalog read");
        },
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      const list = http.client.model.list;
      vi.spyOn(http.client.model, "list").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return list(...args);
      });
      const attempt = new V2StartAttempt();
      const starting = runtime.start(
        {
          threadId: ThreadId.makeUnsafe(`setup-start-${change}`),
          cwd: directory,
          runtimeMode: "approval-required",
          modelSelection,
        },
        attempt,
      );
      const rejected = expect(starting).rejects.toThrow();
      await entered.promise;
      if (change === "settings") enabled = false;
      if (change === "cancel") await runtime.cancelStart(attempt);
      if (change === "process") http.die();
      release.resolve();
      await rejected;
      expect(http.calls.filter(({ method }) => method !== "GET")).toEqual([]);
      expect(http.sessions.size).toBe(0);
      expect(() => runtime.mutations.assertSafe()).not.toThrow();
    });
  });

it("rechecks switch settings after awaited catalog preflight and leaves the current owner intact", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("setup-switch-settings");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection,
    });
    let enabled = true;
    Object.assign(runtime.options, {
      authorizeExecution: async () => {
        if (!enabled) throw new Error("settings changed during catalog read");
      },
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const list = http.client.model.list;
    vi.spyOn(http.client.model, "list").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return list(...args);
    });
    const before = http.calls.length;
    const switching = runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("setup-settings-switch"),
      input: "no mutation",
      modelSelection: { ...modelSelection, model: "second-model" },
    });
    const rejected = expect(switching).rejects.toThrow("settings changed");
    await entered.promise;
    enabled = false;
    release.resolve();
    await rejected;
    expect(http.calls.slice(before).filter(({ method }) => method !== "GET")).toEqual([]);
    expect(runtime.get(threadId).model.id).toBe(modelSelection.model);
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});

it("rebinds terminal history and replays its accepted identity without a new availability check", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("setup-replay-history");
    const started = await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const input = {
      threadId,
      requestMessageId: MessageId.makeUnsafe("setup-original-accepted"),
      input: "original",
      modelSelection,
    };
    const accepted = await runtime.send(input);
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    const retainedLease = await runtime.options.manager.acquire(runtime.options.config);
    try {
      await runtime.stop(threadId);
      http.modelUnavailable = true;
      const list = vi.spyOn(http.client.model, "list");
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection,
        resumeCursor: started.resumeCursor,
      });
      expect((await runtime.send(input)).turnId).toBe(accepted.turnId);
      expect(list).not.toHaveBeenCalled();
      expect(
        http.calls.filter(
          ({ method, pathname }) => method === "POST" && pathname === "/api/session",
        ),
      ).toHaveLength(1);
      expect(http.calls.filter(({ pathname }) => pathname.endsWith("/prompt"))).toHaveLength(1);
    } finally {
      await retainedLease.release();
    }
  });
});

it("rejects a public-only idle switch before native mutation and leaves the original owner usable", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("setup-idle-switch");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const owner = runtime.get(threadId);
    const before = http.calls.length;
    // The native transport rejects unavailable switches; dispatching one can acquire quarantine.
    const switching = vi
      .spyOn(http.client.session, "switchModel")
      .mockRejectedValue(new Error("native unavailable model"));
    const requestMessageId = MessageId.makeUnsafe("setup-switch-not-admitted");
    await expect
      .soft(
        runtime.send({
          threadId,
          requestMessageId,
          input: "must not dispatch",
          modelSelection: { ...modelSelection, model: "not-connected" },
        }),
      )
      .rejects.toThrow("Connect/configure");
    expect.soft(switching).not.toHaveBeenCalled();
    expect.soft(http.calls.slice(before).filter(({ method }) => method !== "GET")).toEqual([]);
    expect.soft(() => runtime.mutations.assertSafe()).not.toThrow();
    expect.soft(owner.model.id).toBe(modelSelection.model);
    expect
      .soft(
        await Effect.runPromise(
          runtime.options.journal.find({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId,
          }),
        ),
      )
      .toBeUndefined();
    switching.mockRestore();
    await runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("original-still-usable"),
      input: "safe original model",
      modelSelection,
    });
    expect(http.calls.filter(({ pathname }) => pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});
