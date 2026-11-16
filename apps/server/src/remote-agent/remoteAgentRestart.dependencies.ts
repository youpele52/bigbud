import type { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentRestartStore } from "./remoteAgentRestart.types.ts";

export type RemoteAgentReplacementLauncher = (
  runtime: RemoteAgentRuntime,
  attemptId: string,
  oldEpoch: string,
  oldAttemptId: string,
) => Promise<string>;

export interface RemoteAgentRestartDependencies {
  readonly close: (target: string, binding?: RemoteAgentRuntimeBinding) => void;
  readonly reconnect: (
    target: string,
    replacement?: RemoteAgentRuntimeBinding,
    retired?: RemoteAgentRuntimeBinding,
  ) => Promise<void>;
  readonly resolveBinding: typeof remoteAgentAdmission.resolveBinding;
  readonly verifySsh: (target: string) => Promise<void>;
  readonly bindReplacement?: (
    target: string,
    connectionId: string,
    binding: RemoteAgentRuntimeBinding,
  ) => Promise<void>;
  readonly verifyReadiness?: (
    target: string,
    runtime: RemoteAgentRuntime,
    expectedEpoch?: string,
  ) => Promise<string>;
  readonly control?: (target: string) => Promise<{
    readonly run: (command: string) => Promise<string>;
    readonly registry: {
      readonly update: (
        transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry,
      ) => Promise<RemoteAgentRegistry>;
    };
  }>;
  readonly launchReplacement?: RemoteAgentReplacementLauncher;
  readonly store: RemoteAgentRestartStore;
  readonly beginRetirement?: (target: string, generation: string) => Promise<() => void>;
  readonly reconcileRuntime?: (target: string, binding: RemoteAgentRuntimeBinding) => void;
}
