import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import type {
  ShellLaunchIdentity,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { PtySpawnError, type PtyProcess } from "../Services/PTY";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import {
  formatShellCandidate,
  isRetryableShellSpawnError,
  type ShellCandidate,
} from "./Manager.shell";
import type { TerminalSessionState } from "./Manager.types";
import { LOCAL_SHELL_HOST, shellKind } from "./ShellProfiles.identity";

import { spawnDirectShellProfile } from "./Manager.shell.direct";
import type { RemoteAgentShellLaunch } from "../../remote-agent/remoteAgentShellLaunch.ts";

type LaunchCandidate = ShellCandidate & {
  identity?: ShellLaunchIdentity;
  platform?: TerminalShellProfile["platform"];
  shellLaunch?: RemoteAgentShellLaunch;
};

export function trySpawnWith(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  shellCandidates: ReadonlyArray<LaunchCandidate>,
  spawnEnv: NodeJS.ProcessEnv,
  index = 0,
  lastError: PtySpawnError | null = null,
): Effect.Effect<
  {
    process: PtyProcess;
    shellLabel: string;
    dropPathMode: TerminalSessionState["dropPathMode"];
    identity: ShellLaunchIdentity | undefined;
  },
  PtySpawnError
> {
  return Effect.gen(function* () {
    if (index >= shellCandidates.length) {
      const detail = lastError?.message ?? "Failed to spawn PTY process";
      const tried =
        shellCandidates.length > 0
          ? ` Tried shells: ${shellCandidates.map((c) => formatShellCandidate(c)).join(", ")}.`
          : "";
      return yield* new PtySpawnError({
        adapter: "terminal-manager",
        message: `${detail}.${tried}`.trim(),
        ...(lastError ? { cause: lastError } : {}),
      });
    }
    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtySpawnError({
            adapter: "terminal-manager",
            message: "No shell candidate available for PTY spawn.",
          })
      );
    }
    const attempt = yield* Effect.result(
      // Suspended so an adapter that throws before returning an Effect is caught too.
      Effect.suspend(() =>
        candidate.identity && candidate.identity.host.kind !== "local"
          ? spawnDirectShellProfile(
              ctx.ptyAdapter,
              ctx.directShellOwners,
              session,
              {
                shell: candidate.shell,
                args: candidate.args ?? [],
                platform: candidate.platform ?? "other",
                dropPathMode: candidate.dropPathMode,
                identity: candidate.identity,
              },
              spawnEnv,
            )
          : ctx.ptyAdapter.spawn({
              ownerKey: JSON.stringify([session.threadId, session.terminalId]),
              recoverOnly: session.remoteOwnerRecoveryRequired === true,
              ...(candidate.shellLaunch ? { shellLaunch: candidate.shellLaunch } : {}),
              shell: candidate.shell,
              ...(candidate.args ? { args: candidate.args } : {}),
              cwd: isLocalExecutionTarget(session.executionTargetId) ? session.cwd : homedir(),
              cols: session.cols,
              rows: session.rows,
              env: spawnEnv,
              executionTargetId: session.executionTargetId,
              ...(isLocalExecutionTarget(session.executionTargetId) ||
              isWslTerminalTargetId(session.executionTargetId)
                ? {}
                : { remoteCwd: session.cwd }),
            }),
      ).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new PtySpawnError({
              adapter: "terminal-manager",
              message: `PTY adapter failed unexpectedly: ${defect instanceof Error ? defect.message : String(defect)}`,
              cause: defect,
            }),
          ),
        ),
      ),
    );
    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
        dropPathMode: candidate.dropPathMode,
        identity:
          isLocalExecutionTarget(session.executionTargetId) && candidate.dropPathMode !== "wsl"
            ? (candidate.identity ?? {
                host: LOCAL_SHELL_HOST,
                selection: { kind: "legacy-auto" },
                profileId: null,
                kind: shellKind(candidate.shell, process.platform),
                integration: { status: "unknown" },
              })
            : undefined,
      };
    }
    const spawnError = attempt.failure;
    // Explicit profiles never enter a fallback chain, even for ENOENT.
    if (candidate.identity || candidate.shellLaunch || !isRetryableShellSpawnError(spawnError))
      return yield* spawnError;
    return yield* trySpawnWith(ctx, session, shellCandidates, spawnEnv, index + 1, spawnError);
  });
}
