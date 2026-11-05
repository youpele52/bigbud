import { Effect, Fiber, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, MessageId, ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import {
  withV2FacadeCancellationFixture,
  type V2FacadeSyntheticWire,
} from "./Application.facade.cancellation.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

const wire = vi.hoisted(() => ({}) as V2FacadeSyntheticWire);
const discovery = vi.hoisted(() => ({ wait: undefined as (() => Promise<void>) | undefined }));
vi.mock("./Application.shared.ts", () => ({
  readV2SharedApplicationConfig: async () => {
    await discovery.wait?.();
    return {
      workspace: wire.workspace,
      process: { runtimeTargetId: "local", sharedService: { ...wire.descriptor } },
    };
  },
}));
vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    let attached = true;
    return {
      ownership: "borrowed",
      client: wire.client,
      isRunning: () => attached,
      hasExited: () => false,
      onDeath: () => () => {},
      close: async () => {
        attached = false;
      },
    };
  },
}));
vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));

it("production refresh rotates the generation and reenrolls idle canonical ownership without replay or cancellation", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const threadId = ThreadId.makeUnsafe("production-upgrade");
    const adapter = f.registration.adapterService;
    await Effect.runPromise(
      adapter.startSession({
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      }),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        requestMessageId: MessageId.makeUnsafe("before-upgrade"),
        input: "before",
      }),
    );
    const before = (await Effect.runPromise(adapter.listSessions()))[0]!;
    const calls = f.http.calls.length;
    wire.descriptor = { ...wire.descriptor, generation: "synthetic-upgraded-generation" };
    await Effect.runPromise(f.registration.providerService.refresh);
    const after = (await Effect.runPromise(adapter.listSessions()))[0]!;
    expect(after.resumeCursor).toEqual(before.resumeCursor);
    expect(after.lastError, wire.failure).toBeUndefined();
    expect(
      f.http.calls
        .slice(calls)
        .some((call) => /prompt|interrupt|\/stop|\/delete/.test(call.pathname)),
    ).toBe(false);
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        requestMessageId: MessageId.makeUnsafe("after-upgrade"),
        input: "after",
      }),
    );
    expect(f.http.sessions.size).toBe(1);
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
    wire.descriptor = { ...wire.descriptor, generation: "second-upgrade-without-manual-refresh" };
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        requestMessageId: MessageId.makeUnsafe("second-upgrade"),
        input: "third explicit input",
      }),
    );
    expect(f.http.sessions.size).toBe(1);
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(3);
  });
});

it("production refresh repairs accepted output after an upgrade without replaying or interrupting its admission", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const threadId = ThreadId.makeUnsafe("production-active-upgrade");
    const requestMessageId = MessageId.makeUnsafe("active-upgrade-input");
    const adapter = f.registration.adapterService;
    const seen: { type: string; eventId: string }[] = [];
    const watching = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
    );
    await Effect.runPromise(
      adapter.startSession({
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      }),
    );
    f.http.autoComplete = false;
    await Effect.runPromise(
      adapter.sendTurn({ threadId, requestMessageId, input: "still running" }),
    );
    const native = [...f.http.sessions.values()][0]!;
    f.http.permissions.set(native.id, [
      {
        id: "per_upgrade",
        sessionID: native.id,
        action: "webfetch",
        resources: ["https://synthetic.invalid"],
        message: "Retained approval",
      },
    ]);
    const identity = {
      namespace: "foreground" as const,
      ownerThreadId: threadId,
      requestMessageId,
    };
    expect(await Effect.runPromise(f.base.options.journal.find(identity))).toMatchObject({
      state: "accepted",
    });
    const before = f.http.calls.length;
    wire.descriptor = { ...wire.descriptor, generation: "active-upgrade-generation" };
    await Effect.runPromise(f.registration.providerService.refresh);
    expect(await Effect.runPromise(f.base.options.journal.find(identity))).toMatchObject({
      state: "accepted",
    });
    expect(
      f.http.calls
        .slice(before)
        .some((call) => /prompt|interrupt|\/stop|\/delete/.test(call.pathname)),
    ).toBe(false);
    await Effect.runPromise(
      adapter.respondToRequest(threadId, ApprovalRequestId.makeUnsafe("per_upgrade"), "accept"),
    );
    f.http.permissions.set(native.id, []);
    f.http.complete(native.id, "completed while detached");
    await Effect.runPromise(f.registration.providerService.refresh);
    expect(await Effect.runPromise(f.base.options.journal.find(identity))).toMatchObject({
      state: "terminal",
      terminalOutcome: "completed",
    });
    const session = (await Effect.runPromise(adapter.listSessions()))[0]!;
    expect(session.lastError, wire.failure).toBeUndefined();
    expect(session.status).toBe("ready");
    await Effect.runPromise(f.registration.providerService.refresh);
    await expect.poll(() => seen.filter((event) => event.type === "turn.completed").length).toBe(1);
    const outputs = seen.filter(
      (event) => event.type === "item.completed" || event.type === "content.delta",
    );
    expect(new Set(outputs.map((event) => event.eventId)).size).toBe(outputs.length);
    await Effect.runPromise(Fiber.interrupt(watching));
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(f.http.sessions.size).toBe(1);
  });
});

it("keeps healthy facade sends and approvals available when another retained owner cannot recover", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const adapter = f.registration.adapterService;
    const blocked = ThreadId.makeUnsafe("blocked-upgrade-owner");
    const healthy = ThreadId.makeUnsafe("healthy-upgrade-owner");
    for (const threadId of [blocked, healthy]) {
      await Effect.runPromise(
        adapter.startSession({
          threadId,
          cwd: f.directory,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        }),
      );
      f.http.autoComplete = threadId === blocked;
      await Effect.runPromise(
        adapter.sendTurn({
          threadId,
          requestMessageId: MessageId.makeUnsafe(`${threadId}-input`),
          input: "original input",
        }),
      );
    }
    const [a, b] = [...f.http.sessions.values()];
    f.http.permissions.set(b!.id, [
      {
        id: "per_healthy_upgrade",
        sessionID: b!.id,
        action: "webfetch",
        resources: ["https://synthetic.invalid"],
        message: "Retained healthy approval",
      },
    ]);
    // A's immutable identity no longer matches; it must not poison B's shared graph.
    f.http.sessions.set(a!.id, {
      ...a!,
      metadata: { ...a!.metadata, bigbud_thread: "conflicting-owner" },
    });
    const before = f.http.calls.length;
    wire.descriptor = { ...wire.descriptor, generation: "mixed-owner-upgrade" };
    try {
      await Effect.runPromise(f.registration.providerService.refresh);
      await expect(
        Effect.runPromise(
          adapter.sendTurn({
            threadId: blocked,
            requestMessageId: MessageId.makeUnsafe("blocked-retry"),
            input: "must not dispatch",
          }),
        ),
      ).rejects.toThrow();
      await Effect.runPromise(
        adapter.respondToRequest(
          healthy,
          ApprovalRequestId.makeUnsafe("per_healthy_upgrade"),
          "accept",
        ),
      );
      f.http.permissions.set(b!.id, []);
      f.http.complete(b!.id);
      await Effect.runPromise(f.registration.providerService.refresh);
      f.http.autoComplete = true;
      await Effect.runPromise(
        adapter.sendTurn({
          threadId: healthy,
          requestMessageId: MessageId.makeUnsafe("healthy-next-input"),
          input: "explicit next input",
        }),
      );
      const sessions = await Effect.runPromise(adapter.listSessions());
      expect(sessions.find((session) => session.threadId === blocked)?.lastError).toContain(
        "mismatch",
      );
      expect(sessions.find((session) => session.threadId === healthy)?.lastError).toBeUndefined();
      const calls = f.http.calls.slice(before);
      expect(calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(calls.some((call) => /interrupt|\/stop|\/delete/.test(call.pathname))).toBe(false);
      expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(3);
      expect(f.http.sessions.size).toBe(2);
    } finally {
      f.http.sessions.set(a!.id, a!);
      // Restore the synthetic identity and await its local retry before fixture shutdown.
      await expect
        .poll(async () => {
          await Effect.runPromise(f.registration.providerService.refresh);
          return (await Effect.runPromise(adapter.listSessions())).find(
            (session) => session.threadId === blocked,
          )?.lastError;
        })
        .toBeUndefined();
    }
  });
});

it("rejects a late upgrade candidate after consent revocation without cancelling native execution", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const threadId = ThreadId.makeUnsafe("production-upgrade-race");
    const adapter = f.registration.adapterService;
    await Effect.runPromise(
      adapter.startSession({
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      }),
    );
    const held = deferred<void>(),
      entered = deferred<void>();
    discovery.wait = async () => {
      entered.resolve();
      await held.promise;
    };
    const before = f.http.calls.length;
    wire.descriptor = { ...wire.descriptor, generation: "late-untrusted-generation" };
    const refreshing = Effect.runPromise(f.registration.providerService.refresh);
    try {
      await entered.promise;
      await Effect.runPromise(
        f.settings.updateSettings({ providers: { opencodeV2: { enabled: false } } }),
      );
      held.resolve();
      await refreshing;
      expect(
        f.http.calls
          .slice(before)
          .some((call) => /prompt|interrupt|\/stop|\/delete/.test(call.pathname)),
      ).toBe(false);
      expect(f.http.sessions.size).toBe(1);
      await expect(
        Effect.runPromise(adapter.sendTurn({ threadId, input: "must not dispatch" })),
      ).rejects.toThrow();
    } finally {
      discovery.wait = undefined;
      held.resolve();
      await Effect.runPromise(
        f.settings.updateSettings({ providers: { opencodeV2: { enabled: true } } }),
      );
      await Effect.runPromise(f.registration.providerService.refresh);
      await Effect.runPromise(f.registration.providerService.refresh);
      expect(
        (await Effect.runPromise(adapter.listSessions()))[0]?.lastError,
        wire.failure,
      ).toBeUndefined();
    }
  });
});
