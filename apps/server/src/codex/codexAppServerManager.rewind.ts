import type {
  ProviderExactRewindInput,
  ProviderPreparedRewind,
} from "../provider/Services/ProviderRewind.ts";
import { hasQualifiedCodexModernProtocol } from "./codexAppServerManager.capabilities.ts";
import {
  readCodexThreadHistory,
  verifyCodexHistoryStable,
} from "./codexAppServerManager.history.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { readResumeThreadId } from "./codexAppServerManager.utils.ts";
import { compactBlocksWork } from "./codexAppServerManager.controls.state.ts";
import {
  assertCodexRewindBoundary,
  retainedCodexTurnIds,
} from "./codexAppServerManager.rewind.boundary.ts";
export { assertCodexRewindBoundary } from "./codexAppServerManager.rewind.boundary.ts";

function assertIdle(context: CodexSessionContext, input: ProviderExactRewindInput) {
  if (
    context.stopping ||
    compactBlocksWork(context) ||
    context.child.exitCode !== null ||
    context.child.killed ||
    context.session.sessionEpoch !== input.sessionEpoch ||
    !["ready", "error"].includes(context.session.status) ||
    context.session.activeTurnId ||
    context.pending.size > 0 ||
    context.pendingApprovals.size > 0 ||
    context.pendingUserInputs.size > 0 ||
    (context.pendingToolCalls ?? 0) > 0 ||
    [...context.collabChildTurns.values()].some((turn) => turn !== null)
  ) {
    throw new Error(
      "Codex rewind requires the same live idle session with no pending interactions or child turns.",
    );
  }
}

/** Preflight is repeated immediately before mutation; the caller owns the thread lease. */
export async function prepareCodexRewind(
  context: CodexSessionContext,
  input: ProviderExactRewindInput,
  ops: TurnOps,
) {
  assertIdle(context, input);
  if (!hasQualifiedCodexModernProtocol(context.runtimeVersion))
    throw new Error("Exact Codex rewind is unavailable for this runtime version.");
  const history = await readCodexThreadHistory(context, ops);
  await verifyCodexHistoryStable(context, history, ops);
  assertIdle(context, input);
  if (
    history.historyMode !== "paginated" ||
    history.ephemeral !== false ||
    history.nativeStatus !== "idle" ||
    history.turns.some(
      (turn) => !["completed", "failed", "interrupted"].includes(turn.status ?? ""),
    )
  )
    throw new Error(
      "Exact Codex rewind requires persistent paginated history and verified native idleness.",
    );
  const nativeTurnIds = assertCodexRewindBoundary(input, history);
  return {
    nativeThreadId: history.threadId,
    runtimeVersion: context.runtimeVersion!,
    nativeTurnIds,
  };
}

/** Never retries a mutation, even when Codex commits storage and then reports reload failure. */
export async function revertCodexThread(
  context: CodexSessionContext,
  input: ProviderPreparedRewind,
  ops: TurnOps,
) {
  const prepared = await prepareCodexRewind(context, input, ops);
  if (
    prepared.nativeThreadId !== input.nativeThreadId ||
    prepared.runtimeVersion !== input.runtimeVersion ||
    (input.nativeTurnIds !== undefined &&
      JSON.stringify(input.nativeTurnIds) !== JSON.stringify(prepared.nativeTurnIds))
  )
    throw new Error("Codex native thread/runtime identity changed after durable preflight.");
  if (input.firstRemovedTurnId !== null) {
    context.historyGeneration = (context.historyGeneration ?? 0) + 1;
    try {
      await ops.sendRequest(context, "thread/revert", {
        threadId: prepared.nativeThreadId,
        beforeTurnId: input.firstRemovedTurnId,
      });
    } catch (error) {
      if (error instanceof CodexRpcError && error.delivery !== "possibly-applied") throw error;
      // A JSON-RPC error can follow the durable commit. Only hydration can establish outcome.
    }
  }
  return verifyCodexRewind(context, { ...input, nativeTurnIds: prepared.nativeTurnIds }, ops);
}

/** Verify again after filesystem restoration to detect observable external-client divergence. */
export async function verifyCodexRewind(
  context: CodexSessionContext,
  input: ProviderPreparedRewind,
  ops: TurnOps,
) {
  const retained = await readCodexThreadHistory(context, ops);
  await verifyCodexHistoryStable(context, retained, ops);
  assertIdle(context, input);
  const expectedNativeIds = retainedCodexTurnIds(input);
  const canonicalPrefix = input.expectedTurnIds.slice(0, input.targetTurnCount);
  assertCodexRewindBoundary(
    {
      ...input,
      expectedTurnIds: canonicalPrefix,
      currentTurnCount: canonicalPrefix.length,
      firstRemovedTurnId: null,
    },
    retained,
  );
  if (
    readResumeThreadId(context.session) !== input.nativeThreadId ||
    context.runtimeVersion !== input.runtimeVersion ||
    retained.threadId !== input.nativeThreadId ||
    retained.nativeStatus !== "idle" ||
    retained.historyMode !== "paginated" ||
    retained.ephemeral !== false ||
    retained.turns.length !== expectedNativeIds.length ||
    retained.turns.some((turn, index) => turn.id !== expectedNativeIds[index])
  )
    throw new Error(
      "Codex revert outcome is uncertain; retained history does not match the exact checkpoint prefix.",
    );
  return retained;
}
