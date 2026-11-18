import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import {
  RemoteShellDiscoveryError,
  remoteShellHost,
  sshShellTarget,
  type RemoteShellDiscoveryInput,
} from "./ShellProfiles.remote.identity";
import { runSshCommand } from "../../ssh/sshProcess";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault";
import { runRemoteAgentShellInventory } from "../../remote-agent/remoteAgentShellInventory";
import type { ProcessRunResult } from "../../utils/processRunner";
import { wslProbeArgs } from "./Manager.wsl.invocation";
import { decodeWslOutput, runWslProcess } from "./Manager.wsl.process";
import {
  decodeRemoteShellInventory,
  REMOTE_SHELL_CLEAN_SCRIPT,
  REMOTE_SHELL_OUTPUT_BYTES,
  REMOTE_SHELL_PROBE_SCRIPT,
  REMOTE_SHELL_TIMEOUT_MS,
} from "./ShellProfiles.remote.protocol";

export interface RemoteShellDiscoveryDependencies {
  readonly runSshCommand?: typeof runSshCommand;
  readonly isRemoteAgentExecutionTarget?: typeof isRemoteAgentExecutionTarget;
  readonly runRemoteAgentShellInventory?: typeof runRemoteAgentShellInventory;
  readonly runWslProcess?: typeof runWslProcess;
  readonly platform?: NodeJS.Platform;
}

const unsupported = () => new RemoteShellDiscoveryError({ reason: "unsupported-target" });

function checkedOutput(result: ProcessRunResult, wsl: boolean): string {
  if (result.timedOut) throw new RemoteShellDiscoveryError({ reason: "timed-out" });
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    // The shared UTF-8 decoder strips a leading BOM; inventory framing must not hide noise.
    (wsl && result.stdout.startsWith("\xef\xbb\xbf")) ||
    Buffer.byteLength(result.stdout, wsl ? "latin1" : "utf8") > REMOTE_SHELL_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, wsl ? "latin1" : "utf8") > REMOTE_SHELL_OUTPUT_BYTES
  )
    throw new RemoteShellDiscoveryError({ reason: "probe-failed" });
  // NUL inventory must never take the WSL listing's UTF-16 heuristic.
  return wsl ? decodeWslOutput(result.stdout, false) : result.stdout;
}

/** Execution-host inventory only; neither transport failures nor unsupported hosts fall back. */
export const discoverRemoteShellProfiles = Effect.fn("discoverRemoteShellProfiles")(function* (
  input: RemoteShellDiscoveryInput,
  dependencies: RemoteShellDiscoveryDependencies = {},
): Effect.fn.Return<readonly TerminalShellProfile[], RemoteShellDiscoveryError> {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const host = remoteShellHost(input);
      const deadline = performance.now() + REMOTE_SHELL_TIMEOUT_MS;
      let result: ProcessRunResult;
      if (host.kind === "wsl") {
        if ((dependencies.platform ?? process.platform) !== "win32") throw unsupported();
        const identity = input.wslIdentity!;
        result = await (dependencies.runWslProcess ?? runWslProcess)(
          wslProbeArgs({
            distribution: host.distribution,
            identity,
            script: REMOTE_SHELL_CLEAN_SCRIPT,
            args: [REMOTE_SHELL_PROBE_SCRIPT, "wsl", identity.username, String(identity.uid)],
          }),
          {
            signal,
            timeoutMs: REMOTE_SHELL_TIMEOUT_MS,
            maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
            outputMode: "error",
          },
        );
      } else {
        const args = [
          "-i",
          "PATH=/usr/bin:/bin",
          "LC_ALL=C",
          "/bin/sh",
          "-c",
          REMOTE_SHELL_PROBE_SCRIPT,
          "sh",
          "ssh",
          sshShellTarget(input).user,
        ];
        const options = {
          executionTargetId: input.executionTargetId,
          args,
          signal,
          timeoutMs: REMOTE_SHELL_TIMEOUT_MS,
          maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
        };
        if (
          (dependencies.isRemoteAgentExecutionTarget ?? isRemoteAgentExecutionTarget)(
            input.executionTargetId,
          )
        ) {
          result = await (
            dependencies.runRemoteAgentShellInventory ?? runRemoteAgentShellInventory
          )(options);
        } else {
          result = await (dependencies.runSshCommand ?? runSshCommand)({
            ...options,
            command: "/usr/bin/env",
            allocateTty: false,
            shellMode: "clean-posix",
            allowNonZeroExit: true,
            outputMode: "error",
          });
        }
      }
      signal.throwIfAborted();
      if (performance.now() >= deadline)
        throw new RemoteShellDiscoveryError({ reason: "timed-out" });
      return decodeRemoteShellInventory(checkedOutput(result, host.kind === "wsl"), host);
    },
    catch: (error) =>
      Schema.is(RemoteShellDiscoveryError)(error)
        ? error
        : new RemoteShellDiscoveryError({
            reason:
              error instanceof Error && /\btimed out\b/i.test(error.message)
                ? "timed-out"
                : "probe-failed",
          }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new RemoteShellDiscoveryError({ reason: "timed-out" })),
    }),
  );
});
