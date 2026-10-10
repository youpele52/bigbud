import type { ClientOrchestrationCommand } from "@bigbud/contracts";
import { isLocalExecutionTargetId, OrchestrationDispatchCommandError } from "@bigbud/contracts";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
import { Effect, Option } from "effect";
import {
  OrchestrationEngineService,
  ensureOrchestrationThreadState,
} from "./Services/OrchestrationEngine.ts";
import { resolveProviderSessionExecutionTargets } from "../provider/providerSessionExecutionTargets.ts";

/** Validate ingress and grant host hydration only for a canonically local workspace. */
export const requireClientAttachmentsSupported = Effect.fn("requireClientAttachmentsSupported")(
  function* (command: ClientOrchestrationCommand) {
    if (
      command.type !== "thread.turn.start" &&
      command.type !== "thread.message.submit" &&
      command.type !== "thread.shell.run"
    )
      return false;
    if (!command.message.attachments?.length) return false;
    const explicitIssue =
      providerAttachmentIssue(
        "modelSelection" in command ? command.modelSelection?.provider : undefined,
        command.message.attachments,
      ) ??
      providerAttachmentIssue(
        command.bootstrap?.createThread?.modelSelection.provider,
        command.message.attachments,
      );
    if (explicitIssue)
      return yield* new OrchestrationDispatchCommandError({ message: explicitIssue });
    // Standalone/unknown bindings preserve references, not permission to read host paths.
    const engine = yield* Effect.serviceOption(OrchestrationEngineService);
    if (Option.isNone(engine)) return false;
    const thread = yield* ensureOrchestrationThreadState(
      engine.value,
      command.threadId,
      "operational",
    );
    const issue = providerAttachmentIssue(
      thread?.session?.providerName ?? thread?.modelSelection.provider,
      command.message.attachments,
    );
    if (issue) return yield* new OrchestrationDispatchCommandError({ message: issue });
    if (thread)
      return isLocalExecutionTargetId(
        thread.workspaceExecutionTargetId ?? thread.executionTargetId,
      );
    const bootstrap = command.bootstrap?.createThread;
    if (!bootstrap) return false;
    const model = yield* engine.value.getReadModel();
    const project = model.projects.find((candidate) => candidate.id === bootstrap.projectId);
    if (!project) return false;
    return isLocalExecutionTargetId(
      resolveProviderSessionExecutionTargets({
        ...bootstrap,
        defaultWorkspaceExecutionTargetId:
          project.workspaceExecutionTargetId ?? project.executionTargetId,
      }).workspaceExecutionTargetId,
    );
  },
);
