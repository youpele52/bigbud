import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  TerminalCwdError,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import { parseWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import type { TerminalFolderInput, ResolvedTerminalFolder } from "./Manager.cwd";
import {
  decodeWslOutput,
  listWslDistributions,
  runWslProcess,
  WSL_PROBE_TIMEOUT_MS,
  type WslProcessRunner,
} from "./Manager.wsl.process";
import {
  WSL_CWD_FAILURE_OUTPUT,
  WSL_IDENTITY_SCRIPT,
  WSL_PATH_SCRIPT,
  wslProbeArgs,
} from "./Manager.wsl.invocation";
import { normalizedRuntimeEnv } from "./Manager.shell";

const PATH_ENV_KEYS = new Set([
  "T3CODE_PROJECT_ROOT",
  "T3CODE_WORKTREE_PATH",
  "BIGBUD_PROJECT_ROOT",
  "BIGBUD_WORKTREE_PATH",
]);
const windowsAbsolute = (value: string) =>
  /^[a-zA-Z]:[/\\]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);

function fields(raw: string, marker: string, count: number): string[] {
  const values = decodeWslOutput(raw, false).split("\0");
  if (values.length !== count + 2 || values[0] !== marker || values.at(-1) !== "")
    throw new Error("Malformed WSL terminal probe output.");
  return values.slice(1, -1);
}

function validatedPath(value: string): string {
  // Reject protocol delimiters and terminal-control characters before probing a folder.
  // oxlint-disable-next-line no-control-regex
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096)
    throw new Error("The WSL terminal path is invalid.");
  return value;
}

function linuxPath(value: string): string {
  validatedPath(value);
  if (!value.startsWith("/")) throw new Error("The WSL terminal path is invalid.");
  return value;
}

/** Resolve cwd, context paths and Home using one captured, explicitly pinned Linux identity. */
export function makeResolveWslTerminalFolder(
  runner: WslProcessRunner = runWslProcess,
  platform: NodeJS.Platform = process.platform,
) {
  return Effect.fn("terminal.resolveWslFolder")(function* (
    input: TerminalFolderInput,
  ): Effect.fn.Return<ResolvedTerminalFolder, TerminalExecutionTargetError> {
    const targetError = (detail: string) => new TerminalExecutionTargetError({ ...input, detail });
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const distribution = parseWslTerminalTargetId(input.executionTargetId);
        if (!distribution || platform !== "win32")
          throw new Error("This WSL terminal target is unsupported.");
        const deadline = performance.now() + WSL_PROBE_TIMEOUT_MS;
        // Validate all raw path context before probing: Home fallback must not bypass it.
        validatedPath(input.cwd);
        if (input.worktreePath !== undefined && input.worktreePath !== null)
          validatedPath(input.worktreePath);
        const runtimeEnv = normalizedRuntimeEnv(input.env) ?? {};
        for (const [key, value] of Object.entries(runtimeEnv)) {
          if (PATH_ENV_KEYS.has(key)) validatedPath(value);
        }
        const run = async (args: readonly string[]) => {
          const timeoutMs = deadline - performance.now();
          if (timeoutMs <= 0 || signal.aborted)
            throw new Error("WSL terminal resolution timed out or was cancelled.");
          const result = await runner(args, { signal, timeoutMs });
          if (
            signal.aborted ||
            performance.now() >= deadline ||
            result.timedOut ||
            result.stdoutTruncated ||
            result.stderrTruncated
          )
            throw new Error("WSL terminal resolution did not complete within 10 seconds.");
          return result;
        };
        const listing = await run(["--list", "--quiet"]);
        const available = await listWslDistributions(async () => listing, platform);
        if (!available.distributions.includes(distribution))
          throw new Error(
            "The selected WSL distribution is no longer registered. Choose another target.",
          );
        const captured = await run(wslProbeArgs({ distribution, script: WSL_IDENTITY_SCRIPT }));
        if (captured.code !== 0)
          throw new Error(
            "Could not resolve the selected WSL distribution's default Linux user and HOME.",
          );
        const [username, uidText, rawHome] = fields(captured.stdout, "identity", 3);
        if (
          !username ||
          // oxlint-disable-next-line no-control-regex -- Identity fields cannot contain controls or spaces.
          /[\x00-\x20\x7f]/.test(username) ||
          !/^(0|[1-9]\d*)$/.test(uidText ?? "") ||
          !Number.isSafeInteger(Number(uidText))
        )
          throw new Error("The selected WSL distribution returned an invalid Linux identity.");
        const identity: TerminalWslIdentity = { distribution, username, uid: Number(uidText) };
        const home = linuxPath(rawHome ?? "");
        const probe = async (value: string, directory: boolean, env = runtimeEnv) => {
          validatedPath(value);
          // HOME is part of the captured launch identity, not a later process default.
          const pathValue = validatedPath(value.replace(/^~(?=\/|$)/, () => home));
          const result = await run(
            wslProbeArgs({
              distribution,
              identity,
              script: WSL_PATH_SCRIPT,
              env,
              args: [
                username,
                String(identity.uid),
                pathValue,
                windowsAbsolute(pathValue) ? "windows" : "linux",
                directory ? "directory" : "path",
              ],
            }),
          );
          if (
            result.code === 77 &&
            directory &&
            decodeWslOutput(result.stdout, false) === WSL_CWD_FAILURE_OUTPUT
          )
            throw new TerminalCwdError({ cwd: value, reason: "statFailed" });
          if (result.code !== 0)
            throw new Error(
              "WSL target identity or path translation failed. Check the selected distro, Linux user and wslpath utility.",
            );
          return linuxPath(fields(result.stdout, "path", 1)[0] ?? "");
        };
        let cwd: string;
        // Validate translated output before directory checks: malformed mapping is not a cwd failure.
        const requestedPath = windowsAbsolute(input.cwd)
          ? await probe(input.cwd, false)
          : input.cwd;
        try {
          cwd = await probe(requestedPath, true);
        } catch (error) {
          if (!Schema.is(TerminalCwdError)(error)) throw error;
          // Home shares the launch deadline and can never recapture another user or target.
          const fallback = await probe(home, true, {});
          return {
            cwd: fallback,
            wslIdentity: identity,
            worktreePath: null,
            env: {},
            directoryFallback: {
              requestedCwd: input.cwd,
              reason: "The requested folder is inaccessible",
            },
          };
        }
        const worktreePath = input.worktreePath
          ? await probe(input.worktreePath, false)
          : input.worktreePath;
        const env = { ...runtimeEnv };
        for (const [key, value] of Object.entries(env)) {
          if (PATH_ENV_KEYS.has(key)) env[key] = await probe(value, false);
        }
        return { cwd, worktreePath, env, wslIdentity: identity };
      },
      catch: (error) =>
        targetError(
          error instanceof Error ? error.message : "The selected WSL terminal target failed.",
        ),
    });
  });
}

export const resolveWslTerminalFolder = makeResolveWslTerminalFolder();
