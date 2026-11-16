import { Effect } from "effect";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import type { SessionApiContext } from "./Manager.session.types.ts";

/** An interrupted/failed attach is not execution-host exit evidence. Preserve its same-host lease. */
export function releaseTerminalLeaseAfterLaunchFailure(
  ctx: SessionApiContext,
  input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly executionTargetId: string;
  },
) {
  if (sessionOwnedPtyRuntime(ctx, input.executionTargetId)?.pidNamespace === "backend-host")
    return Effect.void;
  return ctx.releaseWorktreeLease(input);
}
