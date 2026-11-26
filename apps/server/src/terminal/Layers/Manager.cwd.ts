import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import path from "node:path";
import {
  TerminalCwdError,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import { isLocalExecutionTarget } from "../../executionTargets";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { assertSshTargetConnected } from "../../ssh/sshTargetDisconnects.ts";
import type { DirectSshTerminalCwdOwner } from "./Manager.cwd.owner.ts";
import type { RuntimePathIdentity } from "./Manager.types";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { resolveWslTerminalFolder } from "./Manager.wsl";

export const TERMINAL_FOLDER_TIMEOUT_MS = 10_000;
export interface TerminalFolderInput {
  env?: Record<string, string> | undefined;
  threadId: string;
  terminalId: string;
  executionTargetId: string;
  cwd: string;
  worktreePath?: string | null | undefined;
}

export interface ResolvedTerminalFolder {
  wslIdentity?: TerminalWslIdentity | undefined;
  worktreePath?: string | null | undefined;
  env?: Record<string, string> | undefined;
  cwd: string;
  runtimePathIdentity?: RuntimePathIdentity | undefined;
  directoryFallback?: { requestedCwd: string; reason: string };
}

/** Expand only a user's home prefix, with the target platform's path conventions. */
export function expandTerminalHome(cwd: string, home: string, platform = process.platform): string {
  if (cwd === "~") return home;
  if (!/^~[/\\]/.test(cwd)) return cwd;
  return (platform === "win32" ? path.win32 : path.posix).join(home, cwd.slice(2));
}

/**
 * Without the owner's cwd port a remote folder cannot be resolved: the probe is
 * refused typed and no SSH process is started (SSH runs only through the owner).
 */
const probeRemoteFolder = (
  input: TerminalFolderInput,
  _home: boolean,
  _onFolderProbeReady: () => void = () => undefined,
): Effect.Effect<string, TerminalCwdError | TerminalExecutionTargetError> =>
  Effect.fail(
    new TerminalExecutionTargetError({
      ...input,
      detail: "Resolving a terminal folder on this SSH target needs the SSH owner.",
    }),
  );

const probeOwnedRemoteFolder = Effect.fn("terminal.probeOwnedRemoteFolder")(function* (
  owner: DirectSshTerminalCwdOwner,
  input: TerminalFolderInput,
  home: boolean,
) {
  const unavailable = () =>
    new TerminalExecutionTargetError({
      ...input,
      detail: "Could not resolve the terminal folder through the selected SSH owner.",
    });
  const { executionTargetId, cwd } = input;
  if (!cwd || cwd.includes("\0")) {
    return yield* new TerminalExecutionTargetError({
      ...input,
      detail: "The SSH terminal folder path is invalid.",
    });
  }
  const result = yield* Effect.tryPromise({
    try: (signal) => {
      assertSshTargetConnected(executionTargetId);
      return owner.probeCwd({ executionTargetId, cwd, home }, signal);
    },
    catch: unavailable,
  });
  if (result?.kind === "noFolder") {
    return yield* new TerminalCwdError({ cwd: home ? "~" : cwd, reason: "statFailed" });
  }
  if (
    result?.kind !== "resolved" ||
    typeof result.cwd !== "string" ||
    !result.cwd.startsWith("/") ||
    result.cwd.includes("\0")
  ) {
    return yield* unavailable();
  }
  return result.cwd;
});

/** Directory selection is bounded independently of PTY/lease failures; late probes cannot spawn. */
export function makeResolveTerminalFolder(
  assertValidCwd: (cwd: string) => Effect.Effect<void, TerminalCwdError>,
  remoteProbe = probeRemoteFolder,
  localHome: () => string = homedir,
  resolveRuntimePathIdentity?: (
    cwd: string,
  ) => Effect.Effect<RuntimePathIdentity, TerminalCwdError>,
  directSshCwdOwner?: DirectSshTerminalCwdOwner,
) {
  return Effect.fn("terminal.resolveFolder")(function* (
    input: TerminalFolderInput,
  ): Effect.fn.Return<ResolvedTerminalFolder, TerminalCwdError | TerminalExecutionTargetError> {
    if (isWslTerminalTargetId(input.executionTargetId))
      return yield* resolveWslTerminalFolder(input);
    const local = isLocalExecutionTarget(input.executionTargetId);
    // Every SSH target (direct or agent transport) resolves its folder through the
    // Rust owner's cwd probe; there is no TypeScript SSH folder probe.
    const owned =
      !local && parseSshExecutionTarget(input.executionTargetId) ? directSshCwdOwner : undefined;
    const probe = (home: boolean) => {
      let remoteFolderProbeReady = false;
      return (
        local
          ? Effect.gen(function* () {
              const cwd = home ? localHome() : expandTerminalHome(input.cwd, localHome());
              yield* assertValidCwd(cwd);
              const runtimePathIdentity = resolveRuntimePathIdentity
                ? yield* resolveRuntimePathIdentity(home ? cwd : (input.worktreePath ?? cwd))
                : undefined;
              return { cwd, runtimePathIdentity };
            })
          : (owned
              ? probeOwnedRemoteFolder(owned, input, home)
              : remoteProbe(input, home, () => {
                  remoteFolderProbeReady = true;
                })
            ).pipe(Effect.map((cwd) => ({ cwd, runtimePathIdentity: undefined })))
      ).pipe(
        Effect.timeoutOrElse({
          duration: TERMINAL_FOLDER_TIMEOUT_MS,
          orElse: (): Effect.Effect<never, TerminalCwdError | TerminalExecutionTargetError> =>
            local || remoteFolderProbeReady
              ? Effect.fail(
                  new TerminalCwdError({ cwd: home ? "~" : input.cwd, reason: "timedOut" }),
                )
              : Effect.fail(
                  new TerminalExecutionTargetError({
                    ...input,
                    detail: owned
                      ? "The selected SSH owner did not resolve the terminal folder within 10 seconds."
                      : "The SSH target did not connect within 10 seconds. Check its connection and authentication.",
                  }),
                ),
        }),
      );
    };
    return yield* probe(false).pipe(
      Effect.catchTag("TerminalCwdError", (error) =>
        probe(true).pipe(
          Effect.map(
            (folder): ResolvedTerminalFolder => ({
              ...folder,
              directoryFallback: {
                requestedCwd: input.cwd,
                reason:
                  error.reason === "timedOut"
                    ? "Folder resolution exceeded 10 seconds"
                    : error.reason === "notFound"
                      ? "The requested folder does not exist"
                      : error.reason === "notDirectory"
                        ? "The requested path is not a folder"
                        : "The requested folder is inaccessible",
              },
            }),
          ),
          Effect.mapError(
            () =>
              new TerminalExecutionTargetError({
                ...input,
                detail:
                  "The requested terminal folder and this target's Home folder are unavailable. Check folder access and retry.",
              }),
          ),
        ),
      ),
    );
  });
}
