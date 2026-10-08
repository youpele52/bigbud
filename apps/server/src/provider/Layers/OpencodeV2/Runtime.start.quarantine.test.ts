import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2IsolatedMcp } from "./Runtime.mcp.ts";
import { deferred } from "./Test.fixtures.ts";
import { V2StartAttempt } from "./Runtime.start.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("a paused pre-acquisition start cannot launch/create/update/publish after namespace mutation becomes uncertain", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const incumbent = ThreadId.makeUnsafe("incumbent");
    const successor = ThreadId.makeUnsafe("paused-successor");
    await runtime.start({
      threadId: incumbent,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const process = runtime.get(incumbent).lease.process;
    const entered = deferred<void>();
    const resume = deferred<void>();
    Object.assign(runtime.options, {
      authorizeExecution: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const acquire = vi.spyOn(runtime.options.manager, "acquire");
    const pending = runtime.start({
      threadId: successor,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const rejected = expect(pending).rejects.toThrow("quarantined");
    await entered.promise;
    vi.spyOn(http.client.mcp, "add").mockRejectedValue(new Error("unknown native add outcome"));
    await expect(
      new V2IsolatedMcp(runtime, 25).replace(incumbent, {
        synthetic: { type: "remote", url: "http://127.0.0.1:45678/mcp" },
      }),
    ).rejects.toThrow();
    vi.spyOn(process, "close").mockResolvedValue(undefined);
    await runtime.stop(incumbent);
    const calls = http.calls.length;
    resume.resolve();
    await rejected;
    expect(acquire).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(calls);
    expect(runtime.sessions.has(successor)).toBe(false);
    await expect(
      runtime.send({
        threadId: successor,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("blocked"),
        input: "blocked",
      }),
    ).rejects.toThrow();
    expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
    http.die();
  });
});

it("startup permission mutation ignoring abort keeps the namespace fenced across logical release", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const entered = deferred<void>();
    const late = deferred<void>();
    vi.spyOn(http.client.session, "update").mockImplementationOnce(async () => {
      entered.resolve();
      await late.promise;
    });
    const threadId = ThreadId.makeUnsafe("cancelled-update");
    const attempt = new V2StartAttempt();
    const pending = runtime.start(
      { threadId, cwd: directory, modelSelection, runtimeMode: "approval-required" },
      attempt,
    );
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    const lease = await runtime.options.manager.acquire(runtime.options.config);
    vi.spyOn(lease.process, "close").mockResolvedValue(undefined);
    await runtime.cancelStart(attempt);
    await rejected;
    await lease.release();
    await expect(
      runtime.start({
        threadId: ThreadId.makeUnsafe("replacement"),
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      }),
    ).rejects.toThrow("quarantined");
    late.resolve();
    await new Promise((done) => setTimeout(done, 10));
    expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
    expect(
      http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
    ).toHaveLength(1);
    expect(runtime.sessions.size).toBe(0);
    http.die();
  });
});
