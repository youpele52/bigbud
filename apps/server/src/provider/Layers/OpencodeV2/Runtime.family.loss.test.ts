import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";
import { releaseV2Session } from "./Runtime.cleanup.ts";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";

it.each(["startup", "accepted", "idle"] as const)(
  "retains a qualified %s root on host loss with no children, no retained flag and a zero native cache",
  async (phase) => {
    await withV2NativeGuardProduction(
      async ({ runtime, owner, http, send, permission, events }) => {
        http.autoComplete = phase !== "accepted";
        if (phase !== "startup") await send(`zero-cache-${phase}`);
        await owner.familyControl!.refreshNative!();
        if (phase !== "startup")
          expect(await permission(owner.native.id, "shell", ["permitted-root-command"])).toBe(
            "allow",
          );
        // A poll can publish while the callbacks above are still in flight (busyCount 1), and
        // only the next tick republishes. Join the owner's serialized repair queue so the
        // canonical projection reflects the settled state before asserting the preconditions.
        await runtime.withSession(owner.threadId, () => runtime.reconcile(owner));
        expect(owner.family!.children).toHaveLength(0);
        expect(owner.familyControl!.busyCount!()).toBe(0);
        expect(owner.session.retainedFamily).toBeFalsy();
        expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
        if (phase !== "accepted") expect(owner.session.status).toBe("ready");
        const row = owner.row;
        const before = events.length;
        const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
        const detach = vi.fn(owner.detachSubagentGuard!);
        const cleanup = vi.fn(async () => {});
        owner.detachSubagentGuard = detach;
        Object.assign(owner, { resources: { cleanup } });
        try {
          http.die();
          await owner.operation;
          await runtime.reconcile(owner);
          expect(owner.session).toMatchObject({ status: "error", retainedFamily: true });
          expect(owner.familyControl!.busyCount!()).toBe(0);
          if (row)
            expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe(
              row.state,
            );
          expect(
            events
              .slice(before)
              .some((event) => event.type === "session.exited" || event.type === "turn.aborted"),
          ).toBe(false);
          await expect(releaseV2Session(owner)).rejects.toThrow("unconfirmed");
          await expect(runtime.stop(owner.threadId)).rejects.toThrow("unconfirmed");
          runtime.teardown.releaseDead();
          expect(runtime.teardown.has(owner.threadId)).toBe(true);
          expect(runtime.teardown.capacity()).toBe(1);
          await expect(
            runtime.start({
              threadId: owner.threadId,
              cwd: owner.native.location.directory,
              runtimeMode: "full-access",
              modelSelection: {
                provider: "opencodeV2",
                subProviderID: "synthetic-provider",
                model: "synthetic-model",
              },
            }),
          ).rejects.toThrow();
          expect(detach).not.toHaveBeenCalled();
          expect(cleanup).not.toHaveBeenCalled();
          expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
            prompts,
          );
        } finally {
          // Restore only the scripted transport; the actual source-ledger Stop RPC,
          // not host death or a fixture boolean, must authorize guard retirement.
          http.running = true;
          await owner.familyControl!.fence();
          expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
          owner.session = { ...owner.session, retainedFamily: false };
          await releaseV2Session(owner);
          runtime.teardown.releaseDead();
        }
        expect(detach).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(runtime.teardown.has(owner.threadId)).toBe(false);
      },
      "full-access",
      "running",
      true,
    );
  },
);

it("a current authenticated stopped/settled native barrier permits host-exit retirement", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send }) => {
      http.autoComplete = false;
      await send("physical-barrier-before-host-exit");
      const row = owner.row!;
      await owner.familyControl!.fence();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
      const detach = vi.fn(owner.detachSubagentGuard!);
      const cleanup = vi.fn(async () => {});
      owner.detachSubagentGuard = detach;
      Object.assign(owner, { resources: { cleanup } });
      http.die();
      await owner.operation;
      await runtime.reconcile(owner);
      expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe("terminal");
      expect(owner.session.retainedFamily).toBeFalsy();
      await runtime.stop(owner.threadId);
      expect(detach).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalled();
      expect(runtime.teardown.has(owner.threadId)).toBe(false);
    },
    "full-access",
    "running",
    true,
  );
});

it("native host death retains detached-shell uncertainty, admission, guard, Stop and binding quarantine", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("detached-shell-host-loss");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    const start = {
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required" as const,
    };
    await runtime.start(start);
    await runtime.send({
      threadId,
      modelSelection,
      input: "scripted only",
      requestMessageId: MessageId.makeUnsafe("shell-loss-admission"),
    });
    const owner = runtime.get(threadId),
      row = owner.row!;
    const family = await V2OwnedFamily.open(await realpath(runtime.options.config.profileRoot), {
      rootId: owner.native.id,
      threadId,
      storageIdentity: owner.storageIdentity,
    });
    owner.family = family;
    let physicallyTerminated = false;
    owner.familyControl = {
      busyCount: () => (physicallyTerminated ? 0 : 1),
      fence: async () => {
        if (!physicallyTerminated) throw new Error("detached shell termination unconfirmed");
      },
      authorizeInput: async () => {},
    };
    owner.session = { ...owner.session, retainedFamily: true };
    const detach = vi.fn(async () => {}),
      cleanup = vi.fn(async () => {});
    owner.detachSubagentGuard = detach;
    Object.assign(owner, { resources: { cleanup } });
    const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
    http.die();
    await owner.operation;
    await runtime.reconcile(owner);
    expect(owner.lease.process.hasExited?.()).toBe(true);
    expect(family.isFenced).toBe(true);
    expect(owner.session).toMatchObject({ status: "error", retainedFamily: true });
    expect(owner.session.lastError).toContain("unconfirmed");
    expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe("accepted");
    expect(
      events.some(
        (event) => event.type === "session.state.changed" && event.payload.retainedFamily === true,
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "session.exited" || event.type === "turn.aborted"),
    ).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    await expect(runtime.stop(threadId)).rejects.toThrow("unconfirmed");
    runtime.teardown.releaseDead();
    expect(runtime.teardown.has(threadId)).toBe(true);
    expect(runtime.teardown.capacity()).toBe(1);
    await expect(runtime.start(start)).rejects.toThrow();
    expect(detach).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
    // Only this fake physical acknowledgement, not http.die(), permits retirement.
    physicallyTerminated = true;
    await family.confirmNativeDrain();
    owner.session = { ...owner.session, retainedFamily: false };
    await releaseV2Session(owner);
    runtime.teardown.releaseDead();
    expect(detach).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runtime.teardown.has(threadId)).toBe(false);
  });
});
