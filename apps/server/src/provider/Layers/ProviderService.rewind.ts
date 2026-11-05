import { Effect, Option } from "effect";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { hasCodexRewindMarker } from "../Services/ProviderRewind.ts";
import {
  readPersistedCwd,
  readPersistedSessionEpoch,
  toValidationError,
} from "./ProviderServiceHelpers.ts";
import { readResumeThreadId } from "../../codex/codexAppServerManager.utils.ts";
import { assertProviderWorktreeIdentity } from "./ProviderService.worktreeIdentity.ts";
import { readCodexCompactionProofs } from "../Services/ProviderCompaction.ts";

/** Runs inside the existing thread admission lease, including the caller's completion effects. */
export function makeRewindConversation(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
): NonNullable<ProviderServiceShape["rewindConversation"]> {
  return (input, completion) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (
        !binding ||
        binding.provider !== "codex" ||
        hasCodexRewindMarker(binding.runtimePayload) ||
        readPersistedSessionEpoch(binding.runtimePayload) !== input.sessionEpoch ||
        !directory.setCodexRewind
      )
        return yield* toValidationError(
          "ProviderService.rewindConversation",
          "Exact rewind requires an unfenced, current Codex binding and durable marker storage.",
        );
      const adapter = yield* registry.getByProvider("codex");
      if (!adapter.prepareRewind || !adapter.revertThread || !adapter.verifyRewind)
        return yield* toValidationError(
          "ProviderService.rewindConversation",
          "The adapter does not support exact rewind.",
        );
      yield* completion.preflight;
      yield* assertProviderWorktreeIdentity(input.threadId);
      const maintenanceTurns = readCodexCompactionProofs(
        binding.runtimePayload,
        readResumeThreadId(binding) ?? "",
      );
      if (maintenanceTurns === null)
        return yield* toValidationError(
          "ProviderService.rewindConversation",
          "The durable manual compaction proof namespace is invalid.",
        );
      const exactInput = { ...input, maintenanceTurns };
      const native = yield* adapter.prepareRewind(exactInput);
      const current = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (
        !current ||
        current.provider !== binding.provider ||
        readResumeThreadId(current) !== native.nativeThreadId ||
        readPersistedSessionEpoch(current.runtimePayload) !== input.sessionEpoch ||
        current.providerRuntimeExecutionTargetId !== binding.providerRuntimeExecutionTargetId ||
        current.workspaceExecutionTargetId !== binding.workspaceExecutionTargetId ||
        current.executionTargetId !== binding.executionTargetId ||
        readPersistedCwd(current.runtimePayload) !== readPersistedCwd(binding.runtimePayload) ||
        JSON.stringify(current.resumeCursor) !== JSON.stringify(binding.resumeCursor)
      )
        return yield* toValidationError(
          "ProviderService.rewindConversation",
          "The native session binding changed during preflight.",
        );
      yield* completion.preflight;
      let marker: CodexRewindMarker = {
        ...exactInput,
        ...native,
        stage: "prepared",
        runtime: {
          ...(readPersistedCwd(binding.runtimePayload)
            ? { cwd: readPersistedCwd(binding.runtimePayload)! }
            : {}),
          ...(binding.providerRuntimeExecutionTargetId
            ? { providerRuntimeExecutionTargetId: binding.providerRuntimeExecutionTargetId }
            : {}),
          ...(binding.workspaceExecutionTargetId
            ? { workspaceExecutionTargetId: binding.workspaceExecutionTargetId }
            : {}),
          ...(binding.executionTargetId ? { executionTargetId: binding.executionTargetId } : {}),
        },
      };
      const persist = (stage: CodexRewindMarker["stage"]) => {
        marker = { ...marker, stage };
        return directory.setCodexRewind!(input.threadId, marker, input.operationId);
      };
      yield* persist("prepared");
      // Conservatively fenced even if cancellation occurs just before stdin dispatch.
      yield* persist("dispatched-uncertain");
      const prepared = { ...exactInput, ...native };
      yield* adapter.revertThread(prepared);
      yield* persist("native-verified");
      yield* completion.preflight;
      yield* assertProviderWorktreeIdentity(input.threadId);
      yield* completion.restoreFiles;
      yield* persist("files-restored");
      yield* adapter.verifyRewind(prepared);
      yield* completion.preflight;
      yield* completion.completeCanonical;
      yield* persist("canonical-complete");
      yield* directory.setCodexRewind(input.threadId, null, input.operationId);
    });
}
