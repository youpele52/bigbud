import type {
  RemoteAgentConnectionPoolFactory,
  RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import {
  RemoteAgentConnection,
  type RemoteAgentLocalProcessInput,
} from "../remote-agent/remoteAgentConnection.ts";
import { validateRemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";

export interface LocalSupervisorTransportOptions {
  /** Authority-scoped internal identity, separate from user SSH aliases. */
  readonly targetId: string;
  readonly resolveBinding: () => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly connect?: (input: RemoteAgentLocalProcessInput) => RemoteAgentConnection;
  readonly verifyRuntime?: (runtime: RemoteAgentRuntimeBinding["runtime"]) => Promise<void>;
}

export async function connectLocalSupervisorProxy(
  value: RemoteAgentRuntimeBinding["runtime"],
  options: Pick<LocalSupervisorTransportOptions, "connect" | "verifyRuntime"> = {},
): Promise<RemoteAgentConnection> {
  const runtime = validateRemoteAgentRuntime(value);
  if (runtime.origin !== "managed")
    throw new Error("The remote backend requires a managed local supervisor runtime.");
  await (options.verifyRuntime ?? verifyManagedLocalSupervisor)(runtime);
  return (options.connect ?? RemoteAgentConnection.local)({
    binaryPath: runtime.binaryPath,
    mode: "proxy",
    env: {
      BIGBUD_AGENT_STATE_DIR: runtime.statePath,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
  });
}

/** Reuse pool epoch/build/capability validation, connecting only to an independently owned supervisor. */
export function makeLocalSupervisorTransportFactory(
  options: LocalSupervisorTransportOptions,
): RemoteAgentConnectionPoolFactory {
  if (!/^remote-backend:[a-f0-9]{32}$/.test(options.targetId))
    throw new Error("A local supervisor transport requires its backend authority identity.");
  const assertTarget = (target: string) => {
    if (target !== options.targetId)
      throw new Error(
        "The local supervisor transport cannot address another authority or SSH target.",
      );
  };
  return {
    resolveBinding: async (target) => {
      assertTarget(target);
      return options.resolveBinding();
    },
    create: async (target, binding) => {
      assertTarget(target);
      if (!binding || !binding.expectedEpoch)
        throw new Error("A local supervisor connection requires a pinned runtime and epoch.");
      // Closing this connection terminates only its short-lived proxy. It never launches the
      // supervisor and cannot put persistent PTYs under the TypeScript process ledger.
      return connectLocalSupervisorProxy(binding.runtime, options);
    },
  };
}
