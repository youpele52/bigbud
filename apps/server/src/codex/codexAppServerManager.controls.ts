import type {
  ProviderControlsInput,
  ProviderControlsSnapshot,
} from "@bigbud/contracts/server/providerControls";
import { unavailableProviderControls } from "../provider/providerControls.ts";
import { hasQualifiedCodexModernProtocol } from "./codexAppServerManager.capabilities.ts";
import { compactBlocksWork } from "./codexAppServerManager.controls.state.ts";
import { readCodexMcpStatus } from "./codexAppServerManager.controls.mcp.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import { readObject, readString } from "./codexAppServerManager.protocol.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { readResumeThreadId } from "./codexAppServerManager.utils.ts";

function idleReason(context: CodexSessionContext) {
  if (compactBlocksWork(context))
    return "Compaction is pending or its outcome is unknown. No automatic retry.";
  if (
    context.session.status !== "ready" ||
    context.session.activeTurnId ||
    context.pending.size ||
    context.pendingApprovals.size ||
    context.pendingUserInputs.size ||
    context.pendingToolCalls ||
    [...context.collabChildTurns.values()].some((turn) => turn !== null)
  )
    return "Requires an idle session with no pending requests, interactions or child turns.";
  return "";
}

/** Per-session stdio, rust-v0.164.0/rust-v0.166.0 schemas; not runtime/home/config attestation. */
export async function codexProviderControls(
  context: CodexSessionContext,
  input: ProviderControlsInput,
  ops: TurnOps,
  isCurrent: () => boolean,
): Promise<ProviderControlsSnapshot> {
  const nativeThreadId = readResumeThreadId(context.session);
  const assertCurrent = () => {
    if (
      !isCurrent() ||
      context.stopping ||
      context.child.killed ||
      context.child.exitCode !== null ||
      context.session.sessionEpoch !== input.sessionEpoch ||
      readResumeThreadId(context.session) !== nativeThreadId
    )
      throw new Error(
        "The current native session changed; the result was discarded. Do not replay maintenance.",
      );
  };
  assertCurrent();
  const result = {
    ...unavailableProviderControls(
      input,
      "Requires Codex 0.164.0 or 0.166.0 and a persistent paginated native thread.",
    ),
  };
  compactBlocksWork(context);
  result.compactState = context.manualCompact?.state ?? "idle";
  if (!nativeThreadId || !hasQualifiedCodexModernProtocol(context.runtimeVersion)) {
    if (input.action !== "status") throw new Error(result.compact.reason);
    return result;
  }
  const generation = context.historyGeneration ?? 0;
  const metadata = await ops.sendRequest(context, "thread/read", {
    threadId: nativeThreadId,
    includeTurns: false,
  });
  assertCurrent();
  const thread = readObject(metadata, "thread");
  compactBlocksWork(context);
  result.compactState = context.manualCompact?.state ?? "idle";
  if (
    readString(thread, "id") !== nativeThreadId ||
    thread?.ephemeral !== false ||
    thread.historyMode !== "paginated"
  ) {
    if (input.action !== "status") throw new Error(result.compact.reason);
    return result;
  }
  result.mcpStatus = { available: true, reason: "" };
  const reason =
    idleReason(context) ||
    (readString(readObject(thread, "status"), "type") !== "idle" ||
    generation !== (context.historyGeneration ?? 0)
      ? "Native idleness changed during preflight."
      : "");
  result.compact = result.mcpReload = { available: !reason, reason };
  if (input.action === "status") return result;
  if (input.action !== "refresh-mcp" && reason) throw new Error(reason);
  const mutationGeneration =
    (context.historyGeneration ?? 0) + (input.action === "compact" ? 1 : 0);
  const shouldDispatch = () => {
    const admitted =
      isCurrent() &&
      !context.stopping &&
      !context.child.killed &&
      context.child.exitCode === null &&
      context.session.sessionEpoch === input.sessionEpoch &&
      readResumeThreadId(context.session) === nativeThreadId &&
      context.session.status === "ready" &&
      !context.session.activeTurnId &&
      context.pending.size <= 1 &&
      context.pendingApprovals.size === 0 &&
      context.pendingUserInputs.size === 0 &&
      !context.pendingToolCalls &&
      ![...context.collabChildTurns.values()].some((turn) => turn !== null) &&
      (context.historyGeneration ?? 0) === mutationGeneration;
    if (admitted && input.action === "compact" && context.manualCompact)
      context.manualCompact.dispatched = true;
    return admitted;
  };
  if (input.action === "compact") {
    const compact = { state: "submitted" as const, deadline: Date.now() + 60_000 };
    context.manualCompact = compact;
    context.historyGeneration = (context.historyGeneration ?? 0) + 1;
    try {
      assertCurrent();
      await ops.sendRequest(
        context,
        "thread/compact/start",
        { threadId: nativeThreadId },
        20_000,
        shouldDispatch,
      );
      assertCurrent();
    } catch (error) {
      if (context.manualCompact.state !== "completed")
        context.manualCompact.state =
          error instanceof CodexRpcError && error.delivery !== "possibly-applied"
            ? "failed"
            : "unknown";
      result.message = "Compaction submission failed or is uncertain. It was not retried.";
    }
    assertCurrent();
    result.compactState = context.manualCompact.state;
    result.compact = result.mcpReload = {
      available: false,
      reason: "Refresh to inspect the native compaction outcome. No automatic retry.",
    };
    return result;
  }
  if (input.action === "reload-mcp") {
    try {
      assertCurrent();
      await ops.sendRequest(context, "config/mcpServer/reload", undefined, 20_000, shouldDispatch);
      assertCurrent();
      result.reloadState = "completed";
    } catch (error) {
      result.reloadState =
        error instanceof CodexRpcError && error.delivery !== "possibly-applied"
          ? "failed"
          : "unknown";
      result.message =
        "Reload all MCP servers failed or is uncertain; changes may have partially applied. It was not retried.";
    }
  }
  try {
    result.servers = await readCodexMcpStatus(context, nativeThreadId, ops, assertCurrent);
  } catch {
    result.message = [result.message, "MCP status refresh failed; no status was fabricated."]
      .filter(Boolean)
      .join(" ");
  }
  assertCurrent();
  result.compactState = context.manualCompact?.state ?? "idle";
  return result;
}
