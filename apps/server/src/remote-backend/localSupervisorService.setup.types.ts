import * as Data from "effect/Data";
import type { RemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import type { VerifiedBackendGraph } from "./backendGraph.ts";
export const SERVICE_SETUP_REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface LocalSupervisorServiceSetupInput {
  readonly graph: VerifiedBackendGraph;
  readonly rustSource: RemoteAgentInstallSource;
  readonly backendHome: string;
  readonly requestId: string;
  readonly confirmFreshSetup: true;
  readonly restart: boolean;
}
export type LocalSupervisorServiceSetupPhase =
  | "validate"
  | "claim"
  | "stage-runtime"
  | "publish-config"
  | "stage-units"
  | "admit-runtime"
  | "publish-completion";
export class LocalSupervisorServiceSetupError extends Data.TaggedError(
  "LocalSupervisorServiceSetupError",
)<{
  readonly message: string;
  readonly phase: LocalSupervisorServiceSetupPhase;
  readonly needsRepair: boolean;
  readonly cause?: unknown;
}> {}
export interface LocalSupervisorServiceSetupResult {
  readonly status: "configured";
  readonly requestId: string;
  readonly authorityId: string;
  readonly installationFingerprint: string;
  readonly configPath: string;
  readonly runtime: RemoteAgentRuntime;
  readonly epoch: string;
  readonly backendEnabled: false;
  readonly backendStarted: false;
}
