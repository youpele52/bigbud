import type { ModelRef, SessionInfo, SessionMessageInfo } from "@opencode/client";
import type {
  ProviderSession,
  ProviderSessionStartInput,
  ProviderRuntimeEvent,
  ThreadId,
} from "@bigbud/contracts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import type { V2ProcessLease, OpencodeV2ServerManager } from "./ServerManager.ts";
import type { V2ProcessConfig } from "./ServerManager.child.ts";

export interface V2RuntimeSession {
  readonly resources?: V2SessionResources;
  coding?: {
    readonly pending: () => ProviderRuntimeEvent[];
    readonly revoke: () => void;
    readonly cancelActive: () => Promise<void>;
  };
  readonly threadId: ThreadId;
  readonly native: SessionInfo;
  readonly lease: V2ProcessLease;
  model: ModelRef;
  readonly epoch: number;
  readonly storageIdentity: string;
  readonly unregister: () => void;
  readonly unsubscribeDeath: () => void;
  session: ProviderSession;
  row?: ProviderTurnAdmission | undefined;
  stopped: boolean;
  executionBlocked?: string | undefined;
  readonly localTools?: boolean;
  readonly toolPolicy?: import("@opencode/client").PermissionRuleset;
  readonly executionPolicy?: ReturnType<
    typeof import("./Runtime.policy.fingerprint.ts").v2ExecutionPolicy
  >;
  rejectUnsafePermission?: (
    id: string,
  ) => Promise<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>;
  cancelUnsupportedForm?: (form: import("@opencode/client").FormInfo) => Promise<void>;
  dirtyGeneration: number;
  repairQueued: boolean;
  terminalDelivered: boolean;
  operation: Promise<unknown>;
  readonly emitted: Set<string>;
  readonly messages: Map<string, SessionMessageInfo>;
  pendingInteractions?: Map<string, ProviderRuntimeEvent>;
  runtimeState?: { signature: string; sequence: number };
  finalEvents?: ProviderRuntimeEvent[];
  lossPending?: boolean;
  finalPublication?: {
    eventId: string;
    operation: Promise<void>;
    state: "pending" | "succeeded" | "failed";
  };
}

export interface V2SessionResources {
  readonly orchestration?: import("../../../orchestration-tools/threadOrchestrationBridge.shared.ts").ThreadOrchestrationHttpConfig;
  readonly cleanup: () => Promise<void>;
  readonly codingFiles?: import("./Coding.files.ts").V2CodingTarget;
  readonly media?: (
    input: import("@bigbud/contracts/orchestration/provider.ts").ProviderSendTurnInput,
    options?: import("./Runtime.media.content.ts").V2MediaOptions,
  ) => Promise<{
    files: NonNullable<import("@opencode/client").SessionPromptInput["files"]>;
    digest: string;
    references?: string;
    text?: string;
  }>;
}

/** Explicit harness authorization; never inferred from saved provider enabled settings. */
export interface V2IsolatedRuntimeOptions {
  readonly prepareSession?: (
    input: V2StartInput,
    signal: AbortSignal,
    disableTools: boolean,
  ) => Promise<{
    options: V2IsolatedRuntimeOptions;
    input: V2StartInput;
    resources: V2SessionResources;
  }>;
  readonly codingBridge?: import("./Coding.bridge.ts").V2CodingBridge;
  readonly manager: OpencodeV2ServerManager;
  readonly config: V2ProcessConfig;
  readonly journal: ProviderTurnAdmissionsShape;
  readonly emit: (event: ProviderRuntimeEvent) => Promise<void>;
  readonly maxSessions?: number;
  readonly pollIntervalMs?: number;
  readonly attachmentsDir?: string;
  readonly attachmentAdmissionsDir?: string;
  /** App-owned profile with project config discovery disabled. Local Locations only. */
  readonly allowLocalWorkspace?: boolean;
  /** Application-only local builtin tools. Hidden learning and isolated harnesses remain deny-all. */
  readonly enableLocalTools?: boolean;
  /** Development admission fence, rechecked after queued operations acquire ownership. */
  readonly authorizeExecution?: () => Promise<void>;
  /** Disposable loopback MCP fixtures only; never inferred from preview/settings flags. */
  readonly enableIsolatedMcp?: boolean;
  /** Exact synthetic Location authorization from a separately verified remote harness. */
  readonly remoteSessionConformance?: {
    readonly providerRuntimeTargetId: string;
    readonly workspaceTargetId: string;
    readonly profileRoot: string;
    readonly syntheticDirectory: string;
  };
}

export type V2StartInput = ProviderSessionStartInput;
