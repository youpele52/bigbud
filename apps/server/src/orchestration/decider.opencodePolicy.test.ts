import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { requireActiveOpencodeIntegration } from "./decider.opencodePolicy.ts";

const threadId = ThreadId.makeUnsafe("legacy");
const readModel = {
  threads: [
    {
      id: threadId,
      modelSelection: { provider: "opencode", model: "saved" },
      messages: [{ text: "history" }],
    },
  ],
} as unknown as OrchestrationReadModel;
const command = (type: string, extra = {}): OrchestrationCommand =>
  ({ type, threadId, ...extra }) as OrchestrationCommand;

describe("legacy OpenCode command admission", () => {
  it.each([
    "thread.turn.start",
    "thread.message.submit",
    "thread.queued-prompt.flush",
    "thread.turn.steer",
    "thread.turn.interrupt",
    "thread.session.stop",
    "thread.approval.respond",
    "thread.user-input.respond",
    "thread.runtime-mode.set",
    "thread.interaction-mode.set",
    "thread.shell.run",
    "thread.checkpoint.revert",
    "thread.path-checkpoint.restore",
  ])("rejects %s without altering historical projection", async (type) => {
    const before = structuredClone(readModel);
    const result = await Effect.runPromise(
      Effect.result(requireActiveOpencodeIntegration(command(type), readModel)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { detail: LEGACY_OPENCODE_READ_ONLY_MESSAGE },
    });
    expect(readModel).toEqual(before);
  });
  it("rejects new legacy selections and attempts to rebind existing history", async () => {
    for (const candidate of [
      command("thread.create", { modelSelection: { provider: "opencode", model: "saved" } }),
      command("thread.meta.update", { modelSelection: { provider: "opencodeV2", model: "new" } }),
    ]) {
      expect(
        await Effect.runPromise(
          Effect.result(requireActiveOpencodeIntegration(candidate, readModel)),
        ),
      ).toMatchObject({ _tag: "Failure" });
    }
  });
  it.each([
    "thread.archive",
    "thread.delete",
    "thread.pin",
    "thread.queued-prompt.remove",
    "thread.session.set",
    "thread.turn.start.failed",
    "thread.message.assistant.complete",
  ])("permits history administration/settlement %s", async (type) => {
    await expect(
      Effect.runPromise(requireActiveOpencodeIntegration(command(type), readModel)),
    ).resolves.toBeUndefined();
  });
  it("preserves existing V2 and unrelated command routing", async () => {
    for (const provider of ["opencodeV2", "codex", "claudeAgent"]) {
      const active = {
        threads: [{ id: threadId, modelSelection: { provider, model: "saved" } }],
      } as unknown as OrchestrationReadModel;
      await expect(
        Effect.runPromise(requireActiveOpencodeIntegration(command("thread.turn.start"), active)),
      ).resolves.toBeUndefined();
    }
  });
});
