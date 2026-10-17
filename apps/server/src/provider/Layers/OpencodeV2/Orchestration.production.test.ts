import { CommandId, ThreadId } from "@bigbud/contracts";
import { expect, it } from "vitest";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { isThreadTitleLocked } from "../../../orchestration-tools/ThreadTitleLock.ts";

it("shared enrolled executors route create/send/status/list through actual canonical HTTP/SQLite with stable receipts and cross-provider provenance", async () => {
  await withV2ProductionThreadTools(async ({ runtime, source, canonical, invoke }) => {
    const snapshot = await canonical.run(canonical.engine.getReadModel());
    const parent = snapshot.threads.find((thread) => thread.id === source.threadId)!;
    const target = ThreadId.makeUnsafe("other-provider-target");
    const selected = { provider: "codex", model: "unrelated-model" } as const;
    await canonical.run(
      canonical.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("target-create"),
        threadId: target,
        projectId: parent.projectId,
        title: "Target",
        modelSelection: selected,
        runtimeMode: "full-access",
        interactionMode: "default",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }),
    );
    const sent = await invoke(
      "send_thread_message",
      { threadId: target, message: "smile" },
      "stable-send",
    );
    expect(sent).toMatchObject({ ok: true, result: { delivery: "started" } });
    expect(
      await invoke("send_thread_message", { threadId: target, message: "smile" }, "stable-send"),
    ).toEqual(sent);
    await expect(
      invoke("send_thread_message", { threadId: target, message: "changed" }, "stable-send"),
    ).rejects.toThrow("Required");
    const queued = await invoke("send_thread_message", {
      threadId: target,
      message: "wait your turn",
    });
    expect(queued).toMatchObject({ ok: true, result: { delivery: "queued" } });
    const read = await canonical.run(canonical.engine.getReadModel());
    const targetThread = read.threads.find((thread) => thread.id === target)!;
    expect(targetThread.modelSelection).toEqual(selected);
    expect(targetThread.messages.filter((message) => message.text === "smile")).toHaveLength(1);
    expect(
      targetThread.messages.find((message) => message.text === "smile")?.originSegments,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "crossThreadAgent",
          sourceThreads: [{ threadId: source.threadId, title: "Parent" }],
        }),
      ]),
    );
    expect(await invoke("get_thread_status", { threadId: target })).toMatchObject({ ok: true });
    expect(await invoke("list_threads", {})).toMatchObject({ ok: true });
    const renamed = await invoke(
      "rename_thread",
      { title: "Canonically renamed", targetThreadId: target },
      "stable-rename",
    );
    expect(renamed).toMatchObject({ ok: true, title: "Canonically renamed", threadId: target });
    expect(
      await invoke(
        "rename_thread",
        { title: "Canonically renamed", targetThreadId: target },
        "stable-rename",
      ),
    ).toEqual(renamed);
    const renamedThread = (await canonical.run(canonical.engine.getReadModel())).threads.find(
      (thread) => thread.id === target,
    )!;
    expect(renamedThread.title).toBe("Canonically renamed");
    expect(isThreadTitleLocked(target)).toBe(true);
    const created = (await invoke(
      "create_thread",
      { title: "Independent child", task: "Synthetic independent task", watchForCompletion: true },
      "stable-child",
    )) as { result: { childThreadId: string } };
    expect(
      await invoke(
        "create_thread",
        {
          title: "Independent child",
          task: "Synthetic independent task",
          watchForCompletion: true,
        },
        "stable-child",
      ),
    ).toEqual(created);
    const child = (await canonical.run(canonical.engine.getReadModel())).threads.find(
      (thread) => thread.id === created.result.childThreadId,
    )!;
    expect(child.id).not.toBe(source.threadId);
    expect(child.modelSelection).toEqual(parent.modelSelection);
    expect(child.runtimeMode).toBe(parent.runtimeMode);
    await runtime.stop(source.threadId);
    expect(
      (await canonical.run(canonical.engine.getReadModel())).threads.find(
        (thread) => thread.id === child.id,
      )?.deletedAt,
    ).toBe(null);
  });
});

it("canonical required/auto-edit approval stays once-only and revocation immediately cancels pending authority", async () => {
  await withV2ProductionThreadTools(
    async ({ runtime, source, invoke, events, canonical, revokeConsent }) => {
      const pending = invoke("create_thread", {
        title: "Approved",
        task: "Approved independent task",
      });
      await expect
        .poll(() => events.find((event) => event.type === "request.opened"))
        .toBeDefined();
      const request = events.find((event) => event.type === "request.opened")!;
      expect((await canonical.run(canonical.engine.getReadModel())).threads).toHaveLength(1);
      await expect(
        runtime.respondPermission(source.threadId, request.requestId!, "acceptForSession"),
      ).rejects.toThrow("once-only");
      await runtime.respondPermission(source.threadId, request.requestId!, "accept");
      expect(await pending).toMatchObject({ ok: true });
      const before = events.length;
      const denied = invoke("create_thread", { title: "Revoked", task: "Never dispatch" });
      const outcome = denied.catch(() => "denied");
      await expect
        .poll(() => events.slice(before).find((event) => event.type === "request.opened"))
        .toBeDefined();
      await revokeConsent();
      expect(await outcome).toBe("denied");
      expect((await canonical.run(canonical.engine.getReadModel())).threads).toHaveLength(2);
    },
    "approval-required",
  );
});
