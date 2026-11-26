import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isLocalWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { buildPiRpcInvocation } from "./Cli.ts";
import { migrateBundledPiConfig } from "./ConfigMigration.ts";
import { detectPiSettlementSupport, probePiSettlementSupport } from "./RpcProcess.capabilities.ts";
import { getPiRpcCapabilityDenial } from "./RpcProcess.selection.ts";
import { startLocalPiRpcProcess } from "./RpcProcess.local.ts";
import { startOwnedPiProcess } from "./RpcProcess.owner.process.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "./RpcProcess.types.ts";

export type {
  PiRpcAssistantMessageEvent,
  PiRpcCommand,
  PiRpcExtensionUIRequest,
  PiRpcImage,
  PiRpcModel,
  PiRpcProcess,
  PiRpcProcessOptions,
  PiRpcRequestCommand,
  PiRpcResponse,
  PiRpcSessionState,
  PiRpcSlashCommand,
  PiRpcStdoutEvent,
  PiRpcStdoutMessage,
  PiRpcToolResult,
  PiRpcWriteOnlyCommand,
} from "./RpcProcess.types.ts";

/** Local Pi starts a local child; a remote runtime runs only through the SSH owner. */
export async function createPiRpcProcess(options: PiRpcProcessOptions): Promise<PiRpcProcess> {
  const remote = !isLocalProviderRuntimeTarget(options.providerRuntimeTarget);
  const ownerBinding = remote ? options.ownerBinding : undefined;
  const denial = getPiRpcCapabilityDenial(options, "rpc-start", ownerBinding !== undefined);
  if (denial) throw denial;

  const executionTargetId = options.providerRuntimeTarget.executionTargetId;
  if (ownerBinding) {
    const probe = await probePiSettlementSupport(options, undefined, ownerBinding);
    return startOwnedPiProcess({ options, binding: ownerBinding, version: probe.version });
  }
  if (
    isLocalProviderRuntimeTarget(options.providerRuntimeTarget) &&
    buildPiRpcInvocation(options.binaryPath).bundledCliPath
  ) {
    await migrateBundledPiConfig(
      options.env ?? process.env,
      isLocalWorkspaceTarget(options.workspaceTarget)
        ? (options.workspaceTarget.cwd ?? process.cwd())
        : undefined,
    );
  }
  const capabilities = await detectPiSettlementSupport(options);
  return startLocalPiRpcProcess({
    options,
    executionTargetId,
    capabilities,
  });
}
