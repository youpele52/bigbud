import type { PiOwnerRuntime, PiRpcOwner } from "../provider/Layers/Pi/RpcProcess.owner.ts";
import { PI_VERSION_PROBE_MAX_BYTES } from "../provider/Layers/Pi/RpcProcess.version.ts";
import { makeProofDuplexClient } from "./sshOwnerPickerProof.client.agentProxy.ts";
import {
  bindProofProviderScope,
  startCancellableProofProvider,
} from "./sshOwnerPickerProof.client.providerLease.ts";
import type { PickerProofProviderFixture } from "./sshOwnerPickerProof.codec.provider.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

/** Single Linux proof session. No session-file resume or caller-supplied launch settings. */
export function makeProofPiClient(
  targetId: string,
  fixture: PickerProofProviderFixture | undefined,
  /** Configured remote executable for the product provider service, when bound. */
  serviceBinary: string | undefined,
  takeChannels: Parameters<typeof makeProofDuplexClient>[2],
  execute: Parameters<typeof makeProofDuplexClient>[3],
  probe: (
    runtime: PiOwnerRuntime & { cwd: string },
  ) => Promise<{ status: number; stdout: string; stderr: string }>,
): PiRpcOwner {
  const bound = (runtime: PiOwnerRuntime & { readonly sessionFile?: string }) => {
    if (runtime.provider !== "pi" || runtime.executionTargetId !== targetId) {
      throw new PickerProofOwnerError("operationDenied");
    }
    if (serviceBinary !== undefined) {
      if (runtime.binaryPath !== serviceBinary || !runtime.cwd) {
        throw new PickerProofOwnerError("operationDenied");
      }
      return {
        threadId: runtime.threadId,
        sessionEpoch: runtime.sessionEpoch,
        cwd: runtime.cwd,
        binaryPath: runtime.binaryPath,
        ...(runtime.sessionFile !== undefined ? { sessionFile: runtime.sessionFile } : {}),
      };
    }
    return bindProofProviderScope(fixture, runtime);
  };
  const open = makeProofDuplexClient<PiOwnerRuntime>(
    targetId,
    (runtime) => ({ kind: "openProofPi", ...bound(runtime) }),
    takeChannels,
    execute,
  );
  return {
    async probeProvider(runtime, signal) {
      signal.throwIfAborted();
      const scope = bound(runtime);
      const result = await probe({ ...runtime, cwd: scope.cwd });
      signal.throwIfAborted();
      if (
        result.status !== 0 ||
        Buffer.byteLength(result.stdout) > PI_VERSION_PROBE_MAX_BYTES ||
        Buffer.byteLength(result.stderr) > PI_VERSION_PROBE_MAX_BYTES
      ) {
        throw new PickerProofOwnerError("operationDenied");
      }
      return result.stdout;
    },
    startProvider(runtime) {
      if (runtime.sessionFile !== undefined && serviceBinary === undefined) {
        throw new PickerProofOwnerError("invalidOperands");
      }
      bound(runtime);
      return startCancellableProofProvider("Pi", (signal) =>
        open(
          {
            ...runtime,
            ...(runtime.sessionFile !== undefined ? { sessionFile: runtime.sessionFile } : {}),
          },
          signal,
        ),
      );
    },
  };
}
