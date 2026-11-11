import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { ThreadMetadataState } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type { MetadataCapturedContext } from "./ThreadMetadataGeneration.context.ts";
import { metadataSummaryAdapter } from "./ThreadMetadataGeneration.summary.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";

/** Use under the caller's history/settings authority, including the canonical transaction. */
export function metadataContextIsCurrent(
  context: MetadataCapturedContext,
  model: OrchestrationReadModel,
  state: ThreadMetadataState,
  defaultChatCwd: string,
): boolean {
  const thread = model.threads.find((candidate) => candidate.id === context.threadId);
  if (!thread) return false;
  const cwd = resolveThreadWorkspaceCwd({ thread, projects: model.projects, defaultChatCwd });
  return (
    cwd !== undefined &&
    (context.operation === "title"
      ? metadataTitleAdapter.isCurrent(context, thread, state.titleRevision, cwd)
      : metadataSummaryAdapter.isCurrent(context, thread, state.summaryRevision, cwd))
  );
}
