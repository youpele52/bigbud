import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolvePiInvocation, shouldUseWindowsPiShell, quoteWindowsPiShellCommand } from "./Cli.ts";
import type { PiRpcProcessOptions } from "./RpcProcess.types.ts";

const execute = promisify(execFile);

/** agent_settled was introduced in Pi 0.80.4, independently of who installed the runtime. */
export function piVersionCapabilities(output: string) {
  const match = output.trim().match(/^(?:pi\s+v?)?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i);
  if (!match)
    throw new Error(
      "Pi --version did not report a supported semantic version; cannot select the RPC lifecycle safely.",
    );
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return {
    supportsAgentSettled: major! > 0 || minor! > 80 || (minor === 80 && patch! >= 4),
    supportsPromptDisposition: major! > 0 || minor! >= 99,
  };
}

/** Probe the selected host/executable, never the local installation for a remote runtime. */
export async function detectPiSettlementSupport(
  options: PiRpcProcessOptions,
  run: (
    command: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<{ stdout: string }> = execute,
): Promise<ReturnType<typeof piVersionCapabilities>> {
  const local = isLocalProviderRuntimeTarget(options.providerRuntimeTarget);
  const selected = local ? resolvePiInvocation(options.binaryPath) : undefined;
  if (selected?.bundledCliPath) return piVersionCapabilities("1.4.0");
  const invocation = selected
    ? { command: selected.command, args: [...selected.args, "--version"] }
    : buildSshCommandInvocation({
        executionTargetId: options.providerRuntimeTarget.executionTargetId,
        command: options.binaryPath,
        args: ["--version"],
        ...(options.workspaceTarget.cwd ? { cwd: options.workspaceTarget.cwd } : {}),
      });
  const shell = local && shouldUseWindowsPiShell(invocation.command);
  try {
    const { stdout } = await run(
      shell ? quoteWindowsPiShellCommand(invocation.command) : invocation.command,
      [...invocation.args],
      {
        env: options.env,
        ...(local && options.workspaceTarget.location === "local" && options.workspaceTarget.cwd
          ? { cwd: options.workspaceTarget.cwd }
          : {}),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4096,
        killSignal: "SIGKILL",
        shell,
      },
    );
    return piVersionCapabilities(String(stdout));
  } catch (cause) {
    throw new Error(
      `Failed to determine Pi RPC lifecycle support for ${options.binaryPath}. Verify that the selected runtime supports --version.`,
      { cause },
    );
  }
}
