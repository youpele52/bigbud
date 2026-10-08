import { Effect } from "effect";
import { ProjectId, type OrchestrationThread, type ThreadId } from "@bigbud/contracts";
import { reviewAndUpdateMemory } from "../../../learning/LearningReview.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import type { ServerConfigShape } from "../../../startup/config.ts";

/** Disposable validation harness: use the existing parser/CAS workflow without persisting memory. */
export function validateSyntheticV2Learning(result: string, threadId: ThreadId, directory: string) {
  const projectId = ProjectId.makeUnsafe("synthetic-native-project");
  return reviewAndUpdateMemory({
    jobId: "synthetic-validation",
    turnId: "synthetic-turn",
    providerService: {
      runBackgroundReview: () => Effect.succeed(result),
    } as unknown as ProviderServiceShape,
    memoryStore: {
      read: (input) =>
        Effect.succeed({ ...input, content: "", updatedAt: "2026-09-30T00:00:00.000Z" }),
      write: () => Effect.die(new Error("Synthetic validation must not apply memory.")),
    },
    config: { cwd: directory } as ServerConfigShape,
    thread: {
      id: threadId,
      projectId,
      messages: [],
      worktreePath: null,
    } as unknown as OrchestrationThread,
    projects: [{ id: projectId, workspaceRoot: directory }],
    sourceUserMessage: "Synthetic input",
    modelSelection: {
      provider: "opencodeV2",
      subProviderID: "bigbud-v2-fixture",
      model: "synthetic-model",
    },
    memoryReviewEnabled: true,
  });
}
