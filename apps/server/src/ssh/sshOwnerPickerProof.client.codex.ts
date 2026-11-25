import {
  bindProofProviderScope,
  startCancellableProofProvider,
} from "./sshOwnerPickerProof.client.providerLease.ts";
import type {
  CodexOwnerRuntime,
  CodexSshOwner,
} from "../codex/codexAppServerManager.process.remote.owner.ts";
import type { PickerProofProviderFixture } from "./sshOwnerPickerProof.codec.provider.ts";
import { makeProofDuplexClient } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

type Probe = CodexSshOwner["probeProvider"];

/** One exact Linux proof session. No home override, MCP config, or default-mode flags. */
export function makeProofCodexClient(
  targetId: string,
  fixture: PickerProofProviderFixture | undefined,
  takeChannels: Parameters<typeof makeProofDuplexClient>[2],
  execute: Parameters<typeof makeProofDuplexClient>[3],
  probe: Probe,
): CodexSshOwner {
  const bound = (runtime: CodexOwnerRuntime) => {
    if (
      runtime.provider !== "codex" ||
      runtime.executionTargetId !== targetId ||
      runtime.homePath !== undefined
    ) {
      throw new PickerProofOwnerError("operationDenied");
    }
    return bindProofProviderScope(fixture, runtime);
  };
  const open = makeProofDuplexClient<CodexOwnerRuntime>(
    targetId,
    (runtime) => ({ kind: "openProofCodex", ...bound(runtime) }),
    takeChannels,
    execute,
  );
  return {
    async probeProvider(runtime, signal) {
      bound(runtime);
      signal.throwIfAborted();
      const result = await probe(runtime, signal);
      signal.throwIfAborted();
      return result;
    },
    startProvider(runtime) {
      if (runtime.enableDefaultModeUserInput) throw new PickerProofOwnerError("invalidOperands");
      bound(runtime);
      return startCancellableProofProvider("Codex", (signal) => open(runtime, signal));
    },
  };
}
