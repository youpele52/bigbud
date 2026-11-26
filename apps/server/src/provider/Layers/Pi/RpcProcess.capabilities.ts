import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolvePiInvocation, shouldUseWindowsPiShell, quoteWindowsPiShellCommand } from "./Cli.ts";
import type { PiRpcProcessOptions } from "./RpcProcess.types.ts";
import { getPiRpcCapabilityDenial } from "./RpcProcess.selection.ts";
import {
  probePiOwnerVersion,
  resolvePiOwnerRuntime,
  type PiRpcOwnerBinding,
} from "./RpcProcess.owner.ts";

import {
  PI_VERSION_PROBE_MAX_BYTES,
  PI_VERSION_PROBE_TIMEOUT_MS,
  piVersionCapabilities,
} from "./RpcProcess.version.ts";

const execute = promisify(execFile);

export interface PiSettlementProbe {
  readonly version: string;
  readonly capabilities: ReturnType<typeof piVersionCapabilities>;
}

/**
 * Probe the selected host/executable, never the local installation for a remote runtime.
 * A selected owner runtime is probed only through its typed `probeProvider` port, bounded to
 * the same five seconds and 4 KiB per stream. Only local Pi runs a local `--version` probe;
 * a remote runtime without an owner binding is refused before any process starts.
 */
export async function probePiSettlementSupport(
  options: PiRpcProcessOptions,
  run: (
    command: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<{ stdout: string }> = execute,
  binding?: PiRpcOwnerBinding,
): Promise<PiSettlementProbe> {
  const denial = getPiRpcCapabilityDenial(options, "version-probe", binding !== undefined);
  if (denial) throw denial;

  const local = isLocalProviderRuntimeTarget(options.providerRuntimeTarget);
  if (!local && binding) {
    const runtime = resolvePiOwnerRuntime({
      owner: binding.owner,
      threadId: binding.threadId,
      sessionEpoch: binding.sessionEpoch,
      providerRuntimeTarget: options.providerRuntimeTarget,
      workspaceTarget: options.workspaceTarget,
      binaryPath: options.binaryPath,
    });
    const version = await probePiOwnerVersion(binding.owner, runtime);
    return { version, capabilities: piVersionCapabilities(version) };
  }

  if (!local) {
    throw new Error(
      `Pi version probing for ${options.providerRuntimeTarget.executionTargetId} runs only through the SSH owner. No SSH process was started.`,
    );
  }
  const selected = resolvePiInvocation(options.binaryPath);
  if (selected.bundledCliPath) {
    const version = "1.4.0";
    return { version, capabilities: piVersionCapabilities(version) };
  }
  const invocation = { command: selected.command, args: [...selected.args, "--version"] };
  const shell = shouldUseWindowsPiShell(invocation.command);
  try {
    const { stdout } = await run(
      shell ? quoteWindowsPiShellCommand(invocation.command) : invocation.command,
      [...invocation.args],
      {
        env: options.env,
        ...(options.workspaceTarget.location === "local" && options.workspaceTarget.cwd
          ? { cwd: options.workspaceTarget.cwd }
          : {}),
        encoding: "utf8",
        timeout: PI_VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: PI_VERSION_PROBE_MAX_BYTES,
        killSignal: "SIGKILL",
        shell,
      },
    );
    const version = String(stdout);
    return { version, capabilities: piVersionCapabilities(version) };
  } catch (cause) {
    throw new Error(
      `Failed to determine Pi RPC lifecycle support for ${options.binaryPath}. Verify that the selected runtime supports --version.`,
      { cause },
    );
  }
}

export async function detectPiSettlementSupport(
  options: PiRpcProcessOptions,
  run: (
    command: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<{ stdout: string }> = execute,
  binding?: PiRpcOwnerBinding,
): Promise<ReturnType<typeof piVersionCapabilities>> {
  return (await probePiSettlementSupport(options, run, binding)).capabilities;
}
