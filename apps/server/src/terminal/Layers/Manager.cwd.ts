import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import path from "node:path";
import {
  TerminalCwdError,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import { isLocalExecutionTarget } from "../../executionTargets";
import { runSshCommand } from "../../ssh/sshProcess";
import { assertSshExecutionTargetReadyAsync } from "../../ssh/sshVerification";
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

const REMOTE_FOLDER_PROBE = [
  'printf "\\035"',
  'p="$1"; if [ "$2" = home ]; then p="$HOME"; fi',
  'case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/${p#\\~/}";; esac',
  '[ -n "$p" ] && [ -d "$p" ] && [ -x "$p" ] && cd "$p" 2>/dev/null || exit 77',
  'p=$(pwd -P) || exit 78; printf "\\036%s\\037" "$p"',
].join("; ");

/** Probe the SSH user's folder without interpreting connection failures as directory failures. */
const probeRemoteFolder = Effect.fn("terminal.probeRemoteFolder")(function* (
  input: TerminalFolderInput,
  home: boolean,
  onFolderProbeReady: () => void = () => undefined,
) {
  let folderProbeReady = false;
  const result = yield* Effect.tryPromise({
    try: () =>
      runSshCommand({
        executionTargetId: input.executionTargetId,
        command: "sh",
        args: ["-lc", REMOTE_FOLDER_PROBE, "sh", input.cwd, home ? "home" : "folder"],
        allowNonZeroExit: true,
        timeoutMs: TERMINAL_FOLDER_TIMEOUT_MS,
        maxBufferBytes: 8192,
        onStdoutChunk: (chunk) => {
          if (chunk.includes("\x1d")) {
            folderProbeReady = true;
            onFolderProbeReady();
          }
        },
      }),
    catch: () =>
      new TerminalExecutionTargetError({
        ...input,
        detail:
          "Could not resolve the terminal folder on this SSH target. Check its connection and authentication.",
      }),
  });
  if (result.timedOut && folderProbeReady)
    return yield* new TerminalCwdError({ cwd: home ? "~" : input.cwd, reason: "timedOut" });
  if (result.code === 77)
    return yield* new TerminalCwdError({ cwd: home ? "~" : input.cwd, reason: "statFailed" });
  const start = result.stdout.lastIndexOf("\x1e");
  const end = result.stdout.lastIndexOf("\x1f");
  const cwd = start >= 0 && end > start ? result.stdout.slice(start + 1, end) : "";
  if (result.timedOut || result.code !== 0 || !cwd.startsWith("/")) {
    return yield* new TerminalExecutionTargetError({
      ...input,
      detail: "The SSH folder probe did not complete. Check the target connection and retry.",
    });
  }
  return cwd;
});

/** Directory selection is bounded independently of PTY/lease failures; late probes cannot spawn. */
export function makeResolveTerminalFolder(
  assertValidCwd: (cwd: string) => Effect.Effect<void, TerminalCwdError>,
  remoteProbe = probeRemoteFolder,
  localHome: () => string = homedir,
  resolveRuntimePathIdentity?: (
    cwd: string,
  ) => Effect.Effect<RuntimePathIdentity, TerminalCwdError>,
) {
  return Effect.fn("terminal.resolveFolder")(function* (
    input: TerminalFolderInput,
  ): Effect.fn.Return<ResolvedTerminalFolder, TerminalCwdError | TerminalExecutionTargetError> {
    if (isWslTerminalTargetId(input.executionTargetId))
      return yield* resolveWslTerminalFolder(input);
    const local = isLocalExecutionTarget(input.executionTargetId);
    if (!local) {
      yield* Effect.tryPromise({
        try: () => assertSshExecutionTargetReadyAsync(input.executionTargetId),
        catch: () =>
          new TerminalExecutionTargetError({
            ...input,
            detail: "The SSH target is not ready. Verify its connection and authentication.",
          }),
      });
    }
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
          : remoteProbe(input, home, () => {
              remoteFolderProbeReady = true;
            }).pipe(Effect.map((cwd) => ({ cwd, runtimePathIdentity: undefined })))
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
                    detail:
                      "The SSH target did not connect within 10 seconds. Check its connection and authentication.",
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
