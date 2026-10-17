import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runV2ContainedShell } from "./Execution.sandbox.ts";
import { callV2Orchestration, prepareV2OrchestrationRequest } from "./Execution.orchestration.ts";

export interface V2ExecutionInput {
  readonly command?: string | undefined;
  readonly request?: unknown;
}

/** Exact accepted intent is included in canonical approval/fingerprint; runtime/native/profile identities remain separate. */
export function prepareV2ExecutionAction(
  session: V2RuntimeSession,
  profile: string,
  action: "shell" | "orchestration",
  input: V2ExecutionInput,
  identity: readonly string[],
  signal?: AbortSignal,
) {
  const root = session.resources?.codingFiles?.root ?? session.native.location.directory;
  if (action === "shell") {
    if (
      session.resources?.codingFiles?.executionTargetId ||
      session.session.providerRuntimeExecutionTargetId !== "local"
    )
      throw new Error(
        "V2 remote shell containment contract is unavailable; no direct SSH fallback.",
      );
    if (
      typeof input.command !== "string" ||
      !input.command.trim() ||
      Buffer.byteLength(input.command) > 16384
    )
      throw new Error("V2 exact command is required and bounded.");
    return {
      intent: { action, root, command: input.command, containment: "seatbelt-no-fork-no-network" },
      run: (guard: () => Promise<() => void>) =>
        runV2ContainedShell({
          root,
          profile,
          command: input.command!,
          beforeSpawn: guard,
          ...(signal ? { signal } : {}),
        }),
    };
  }
  const config = session.resources?.orchestration;
  if (!config) throw new Error("V2 canonical orchestration bridge is unavailable for this owner.");
  const request = prepareV2OrchestrationRequest(input.request, identity);
  return {
    intent: { action, root, request },
    run: (guard: () => Promise<() => void>) =>
      callV2Orchestration(config, request, identity, guard, signal),
  };
}
