import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ProviderSession } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { resolveProviderSessionExecutionTargets } from "../../provider/providerSessionExecutionTargets.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import { assertV2RemoteLocation } from "../../provider/Layers/OpencodeV2/Application.remoteLocation.ts";
import { decodeV2Cursor } from "../../provider/Layers/OpencodeV2/Runtime.cursor.ts";

/** Reuse must obey the same Location boundary as setup/resume, without replacing live history. */
export const assertActiveV2SessionLocation = Effect.fn("assertActiveV2SessionLocation")(function* (
  session: ProviderSession | undefined,
  effectiveCwd: string,
  canonical?: {
    providerRuntimeExecutionTargetId: string;
    workspaceExecutionTargetId: string;
    stateDir: string;
  },
) {
  if (session?.provider !== "opencodeV2") return;
  yield* Effect.tryPromise({
    try: async () => {
      const targets = resolveProviderSessionExecutionTargets(session);
      if (
        canonical &&
        (targets.providerRuntimeExecutionTargetId !== canonical.providerRuntimeExecutionTargetId ||
          targets.workspaceExecutionTargetId !== canonical.workspaceExecutionTargetId)
      )
        throw new Error("Changed execution target.");
      if (
        targets.providerRuntimeExecutionTargetId === "local" &&
        targets.workspaceExecutionTargetId !== "local"
      ) {
        const selected = resolveWorkspaceTarget({
          executionTargetId: targets.workspaceExecutionTargetId,
          cwd: effectiveCwd,
        });
        if (!canonical || !session.cwd || session.cwd !== selected.cwd)
          throw new Error("Changed remote workspace.");
        const cursor = decodeV2Cursor(session.resumeCursor);
        if (cursor.connectionMode !== "shared") throw new Error("Unproved shared native Location.");
        await assertV2RemoteLocation(
          canonical.stateDir,
          session.threadId,
          targets.workspaceExecutionTargetId,
          session.cwd,
          cursor.directory,
        );
        return;
      }
      // Remote runtime bindings use POSIX Location identity, never the backend's filesystem.
      if (
        session.providerRuntimeExecutionTargetId &&
        session.providerRuntimeExecutionTargetId !== "local"
      ) {
        if (
          !session.cwd ||
          !path.posix.isAbsolute(effectiveCwd) ||
          path.posix.resolve(session.cwd) !== path.posix.resolve(effectiveCwd)
        )
          throw new Error("Changed remote Location.");
        return;
      }
      if (!session.cwd || !path.isAbsolute(session.cwd) || !path.isAbsolute(effectiveCwd))
        throw new Error("Unproved local Location.");
      const [active, selected] = await Promise.all([realpath(session.cwd), realpath(effectiveCwd)]);
      if (active !== selected) throw new Error("Changed local Location.");
    },
    catch: () =>
      new ProviderValidationError({
        operation: "ProviderCommandReactor.ensureSessionForThread",
        issue:
          "V2 active session Location cannot be verified against the current canonical workspace. Restore its original Location; no prompt, replacement or history mutation was admitted.",
      }),
  });
});
