import { CommandId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import {
  validateBootstrapSubmissionIdentity,
  type BootstrapSubmissionDispatch,
} from "./OrchestrationEngine.bootstrapIdentity.ts";

const original = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("bootstrap-identity"),
  threadId: ThreadId.makeUnsafe("thread"),
  message: { messageId: MessageId.makeUnsafe("message"), text: "hello" },
  delivery: "auto",
  createdAt: "2026-09-11T00:00:00.000Z",
  bootstrap: { createThread: { projectId: "project", title: "Thread" } },
} as unknown as Extract<OrchestrationCommand, { type: "thread.message.submit" }>;
const { bootstrap: _bootstrap, ...stripped } = original;
const digest = calculateCommandPayloadDigest(original);
const repository = {
  getByParentCommandId: () =>
    Effect.succeed(
      Option.some({
        ...original.bootstrap!.createThread,
        parentCommandId: original.commandId,
        recipeVersion: "bootstrap-submission/v1" as const,
        originalPayloadDigestVersion: digest.version,
        originalPayloadDigest: digest.digest,
        executionTargetId: null,
        projectId: null,
        projectCwd: null,
        baseBranch: null,
        requestedBranch: null,
        deterministicWorktreePath: null,
        createdAt: original.createdAt,
      }),
    ),
  claimOrInspect: () => Effect.die("unused"),
};

describe("authoritative bootstrap submission identity", () => {
  it("allows only the coordinator to dispatch the stripped original", async () => {
    const handoff: BootstrapSubmissionDispatch = { originalCommand: original };
    await expect(
      Effect.runPromise(
        validateBootstrapSubmissionIdentity({
          command: stripped,
          repository,
          bootstrapSubmission: handoff,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(validateBootstrapSubmissionIdentity({ command: stripped, repository })),
    ).rejects.toMatchObject({ _tag: "OrchestrationCommandIdConflictError" });
  });

  it("rejects changed payloads and command types at the shared boundary", async () => {
    const changed = { ...stripped, message: { ...stripped.message, text: "changed" } };
    await expect(
      Effect.runPromise(validateBootstrapSubmissionIdentity({ command: changed, repository })),
    ).rejects.toMatchObject({ _tag: "OrchestrationCommandIdConflictError" });
    await expect(
      Effect.runPromise(
        validateBootstrapSubmissionIdentity({
          command: { ...stripped, type: "thread.turn.start" } as never,
          repository,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "OrchestrationCommandIdConflictError" });
  });
});
