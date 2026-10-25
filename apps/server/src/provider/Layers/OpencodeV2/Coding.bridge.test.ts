import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";

it("real coding approvals persist native-independent requests, write once, and replay only exact completed receipts", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    const profile = fixture.options.config.profileRoot;
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      codingBridge: coding,
      enableLocalTools: true,
    });
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("coding-approval");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("coding-request"),
        input: "synthetic",
      });
      const owner = runtime.get(threadId);
      const input = {
        action: "write",
        input: { path: "result.py", content: "value = 1\n" },
        sessionID: owner.native.id,
        messageID: "assistant",
        callID: "call",
      };
      const pending = coding.invoke(input);
      await expect
        .poll(() =>
          events.find(
            (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
          ),
        )
        .toBeDefined();
      const request = events.find(
        (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
      )!;
      await expect(readFile(path.join(directory, "result.py"))).rejects.toThrow();
      await runtime.reconcile(owner);
      expect(owner.pendingInteractions?.has(`request.opened:${request.requestId}`)).toBe(true);
      await runtime.respondPermission(threadId, request.requestId!, "accept");
      const result = await pending;
      expect(await readFile(path.join(directory, "result.py"), "utf8")).toBe("value = 1\n");
      expect(await coding.invoke(input)).toEqual(result);
      await expect(
        coding.invoke({ ...input, input: { path: "result.py", content: "wrong" } }),
      ).rejects.toThrow("changed");
      const controller = new AbortController();
      const offset = events.length;
      const cancelled = coding
        .invoke(
          { ...input, callID: "cancelled", input: { path: "cancelled.py", content: "wrong" } },
          controller.signal,
        )
        .catch((error) => error);
      await expect
        .poll(() => events.slice(offset).find((event) => event.type === "request.opened"))
        .toBeDefined();
      controller.abort();
      expect(await cancelled).toBeInstanceOf(Error);
      await runtime.reconcile(owner);
      expect(events.slice(offset).some((event) => event.type === "request.resolved")).toBe(true);
      await expect(readFile(path.join(directory, "cancelled.py"))).rejects.toThrow();
    } finally {
      coding.close();
      await runtime.close();
    }
  });
});

it("queued canonical approval cannot bypass disable or stop; raw shell remains unavailable", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    const profile = fixture.options.config.profileRoot;
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    let enabled = true;
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      codingBridge: coding,
      enableLocalTools: true,
      authorizeExecution: async () => {
        if (!enabled) throw new Error("disabled");
      },
    });
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("coding-revocation");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("coding-revoked"),
        input: "synthetic",
      });
      const owner = runtime.get(threadId);
      const invocation = coding.invoke({
        action: "write",
        input: { path: "revoked.py", content: "wrong" },
        sessionID: owner.native.id,
        messageID: "assistant",
        callID: "revocation",
      });
      const outcome = invocation.catch((error) => error);
      await expect
        .poll(() =>
          events.find(
            (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
          ),
        )
        .toBeDefined();
      const request = events.find(
        (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
      )!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = runtime.withSession(threadId, () => gate);
      const approval = runtime
        .respondPermission(threadId, request.requestId!, "accept")
        .catch((error) => error);
      enabled = false;
      release();
      await held;
      expect(await approval).toBeInstanceOf(Error);
      await expect(readFile(path.join(directory, "revoked.py"))).rejects.toThrow();
      await runtime.stop(threadId);
      expect(await outcome).toBeInstanceOf(Error);
      await expect(
        coding.invoke({
          action: "shell",
          input: { path: "." },
          sessionID: owner.native.id,
          messageID: "assistant",
          callID: "shell",
        }),
      ).rejects.toThrow();
    } finally {
      coding.close();
      await runtime.close();
    }
  });
});
