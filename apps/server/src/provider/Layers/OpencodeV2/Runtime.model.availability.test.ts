import { expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import { ThreadId, MessageId } from "@bigbud/contracts";
import { Effect } from "effect";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";

it("rejects an unavailable catalog selection before journaling or an uncertain native prompt, without fallback", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("catalog-unavailable");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic",
      model: "model",
    } as const;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    http.modelUnavailable = true;
    const requestMessageId = MessageId.makeUnsafe("not-admitted");
    await expect(
      runtime.send({ threadId, requestMessageId, input: "no prompt", modelSelection }),
    ).rejects.toThrow("Connect/configure");
    expect(http.calls.some(({ pathname }) => pathname.endsWith("/prompt"))).toBe(false);
    expect(
      await Effect.runPromise(
        runtime.options.journal.find({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId,
        }),
      ),
    ).toBeUndefined();
  });
});

it("reports an empty native Location HTTP 500 before creating history, without a different-Location fallback", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("location-denied-start");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic",
      model: "model",
    } as const;
    const nativeDirectory = await realpath(directory);
    http.modelHttpFailures.set(nativeDirectory, 500);
    await expect(
      runtime.start({ threadId, cwd: directory, modelSelection, runtimeMode: "full-access" }),
    ).rejects.toThrow(
      `Native model.list returned HTTP 500 for chat Location ${JSON.stringify(nativeDirectory)}`,
    );
    expect(http.sessions.size).toBe(0);
    expect(http.calls.some(({ method }) => method !== "GET")).toBe(false);
    expect(await Effect.runPromise(runtime.options.journal.latestBound(threadId))).toBeUndefined();
    const modelCalls = http.calls.filter(({ pathname }) => pathname === "/api/model");
    expect(modelCalls).toHaveLength(1);
    expect(new URLSearchParams(modelCalls[0]!.search).get("location[directory]")).toBe(
      nativeDirectory,
    );
    // An explicitly requested other Location has inventory, but it never admits this failed chat.
    expect(
      await assertV2ModelAvailable(http.client, "/explicit-other-location", {
        providerID: "synthetic",
        id: "model",
      }),
    ).toMatchObject({ enabled: true, providerID: "synthetic", id: "model" });
    expect(http.sessions.size).toBe(0);
  });
});

it("rejects a Location failure on an established session before journal intent or prompt dispatch", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("location-denied-send");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic",
      model: "model",
    } as const;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    http.modelHttpFailures.set(await realpath(directory), 500);
    const requestMessageId = MessageId.makeUnsafe("location-not-admitted");
    await expect(
      runtime.send({ threadId, requestMessageId, input: "synthetic no prompt", modelSelection }),
    ).rejects.toThrow("macOS Files and Folders permissions");
    expect(http.calls.some(({ pathname }) => pathname.endsWith("/prompt"))).toBe(false);
    expect(
      await Effect.runPromise(
        runtime.options.journal.find({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId,
        }),
      ),
    ).toBeUndefined();
  });
});

it("bounds and escapes Location diagnostics and never exposes arbitrary SDK error data", async () => {
  await withV2RuntimeFixture(async ({ http }) => {
    const directory = '/fixture/"\n' + "x".repeat(1000);
    http.modelHttpFailures.set(directory, 500);
    const error = await assertV2ModelAvailable(http.client, directory, {
      providerID: "synthetic",
      id: "model",
    }).catch((error: unknown) => error);
    expect(String(error)).toContain('\\"\\n');
    expect(String(error)).not.toContain("\n");
    expect(String(error).length).toBeLessThan(800);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).toContain("No prompt or fallback was sent");
    expect(String(error)).not.toContain("Refresh and retry");
  });
});
