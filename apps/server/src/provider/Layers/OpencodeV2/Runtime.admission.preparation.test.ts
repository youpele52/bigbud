import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2HttpStatusError } from "./Client.errors.ts";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { v2ExecutionFailureClass, v2ExecutionIssue } from "./Adapter.execution.errors.ts";

it("completed native family preparation with a lost acknowledgement is retryable without a prompt", async () => {
  await withV2NativeGuardProduction(
    async ({ owner, send, http }) => {
      const authorize = owner.familyControl!.authorizeInput;
      vi.spyOn(owner.familyControl!, "authorizeInput").mockImplementationOnce(async (row) => {
        await authorize(row);
        throw new Error("secret response lost after non-executing authorization");
      });
      await expect(send("family-prepared")).rejects.toMatchObject({
        detail: expect.stringContaining("No prompt dispatched"),
      });
      expect(owner.row?.state).toBe("reserved");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      const generation = owner.family!.generation;
      await send("family-prepared");
      expect(owner.family!.generation).toBe(generation);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      await send("family-prepared");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    },
    "full-access",
    "completed",
    true,
  );
});

it("family preparation can retry the same reservation without admitting a duplicate", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("family-preparation-retry");
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
    const gate = new V2ActivationGate("preparation-retry", "digest", () => {});
    const stamp = gate.verify(directory, "digest", "instance");
    const awaitReady = vi.fn(async () => ({ gate, stamp }));
    Object.assign(runtime.options, { activation: { awaitReady } });
    const authorizeInput = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret native response"))
      .mockResolvedValue(undefined);
    owner.familyControl = {
      authorizeInput,
      fence: async () => {},
    };
    const input = { threadId, requestMessageId: MessageId.makeUnsafe("prepare"), input: "hello" };
    await expect(runtime.send(input)).rejects.toMatchObject({
      _tag: "V2PreparationFailed",
      detail:
        "V2 family authorization failed. No prompt dispatched; retry the same request after resolving preparation.",
    });
    expect(owner.row?.state).toBe("reserved");
    expect(owner.activation?.token).toBeUndefined();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    // This fixture supplies no native family; stop mocking after the failed preparation.
    delete owner.familyControl;
    await runtime.send(input);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(awaitReady).toHaveBeenCalledTimes(2);
    await runtime.send(input);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});

it("prompt failure preserves only sanitized stage/status and never retries dispatch", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("prompt-diagnostic");
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
    const prompt = vi
      .spyOn(http.client.session, "prompt")
      .mockRejectedValueOnce(new V2HttpStatusError(503));
    const input = {
      threadId,
      requestMessageId: MessageId.makeUnsafe("diagnostic"),
      input: "hello",
    };
    await expect(runtime.send(input)).rejects.toMatchObject({
      _tag: "V2AdmissionUnconfirmed",
      detail:
        "V2 prompt dispatch failed (HTTP 503). Admission unconfirmed; no automatic resend. New work may duplicate execution.",
    });
    expect(runtime.get(threadId).row?.state).toBe("dispatch-intent");
    await expect(runtime.send(input)).rejects.toMatchObject({
      detail: expect.stringContaining("Admission remains unconfirmed"),
    });
    expect(prompt).toHaveBeenCalledOnce();
  });
});

it("instruction inventory failures are sanitized, reserved, and not unsafe replay", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("instruction-preparation-diagnostic");
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
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("secret native content"),
    );
    const input = { threadId, requestMessageId: MessageId.makeUnsafe("inventory"), input: "hello" };
    const error = await runtime.send(input).catch((error: unknown) => error);
    // Only the redacted failure kind and error class surface; native error text never does.
    expect(error).toMatchObject({
      _tag: "V2PreparationFailed",
      detail:
        "V2 instruction synchronization: inventory read failed (native: Error). No prompt dispatched; retry the same request after resolving preparation.",
    });
    expect(JSON.stringify(error)).not.toContain("secret native content");
    expect(v2ExecutionFailureClass(error, v2ExecutionIssue(error))).toBe("invalid-request");
    expect(runtime.get(threadId).row?.state).toBe("reserved");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    await runtime.send(input);
    await runtime.send(input);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});
