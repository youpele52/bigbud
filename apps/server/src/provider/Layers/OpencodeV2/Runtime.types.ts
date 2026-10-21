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
  family?: import("./Subagents.ownership.ts").V2OwnedFamily;
  familyQualification?: import("./Runtime.family.ts").V2SubagentQualification | undefined;
  /** Host-exit retirement authority, independent of cached pending counts and UI liveness. */
  familyPhysicalDrain?: import("./Subagents.bridge.drain.ts").V2FamilyPhysicalDrain;
  familyControl?: {
    readonly nativeReceipt?: (
      inputID: string,
    ) => Promise<import("./Subagents.extension.ts").V2FamilyReceipt>;
    readonly confirmCancellation?: () => Promise<void>;
    readonly refreshNative?: () => Promise<void>;
    readonly busyCount?: () => number;
    readonly childBusyCount?: (sessionID: string) => number;
    readonly fence: () => Promise<void>;
    readonly authorizeInput: (
      row: import("@bigbud/contracts/orchestration/providerTurnAdmission.ts").ProviderTurnAdmission,
    ) => Promise<void>;
  };
  detachSubagentGuard?: (() => void | Promise<void>) | undefined;
  /** Exact turn's observed native-arrival fence, retained through physical reservation settlement. */
  backgroundClosure?: { readonly turnId: string; readonly assertCurrent: () => void };
  activation?: {
    readonly gate: import("./PluginSetup.activation.gate.ts").V2ActivationGate;
    readonly stamp: import("./PluginSetup.activation.gate.ts").V2ReadyStamp;
    token?: import("./PluginSetup.activation.gate.ts").V2ExecutionReservation | undefined;
    phase: "startup" | "turn" | "uncertain" | "settled";
  };
  readonly consentPermit?: import("./Application.consent.ts").V2ConsentPermit | undefined;
  readonly sharedTransport?: string;
  readonly resources?: V2SessionResources;
  threadToolsReady?: boolean;
  coding?: {
    readonly pending: () => ProviderRuntimeEvent[];
    readonly revoke: () => void;
    readonly cancelActive: () => Promise<void>;
    readonly busyCount?: () => number;
    /** Releases proven-settled uncertain callbacks before settlement observes `busyCount`. */
    readonly reconcile?: () => Promise<number>;
  };
  /** Sequence of the last native interrupt acknowledgement (see `nextV2SettlementSequence`). */
  interruptAcknowledgedSequence?: number;
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
  /** Polls wait for admission's owner queue; actual stream gaps still invalidate it immediately. */
  admissionInFlight?: boolean;
  /** A downstream fence rejected queued output; native terminal evidence is not delivery proof. */
  publicationUnconfirmed?: boolean;
  terminalDelivered: boolean;
  operation: Promise<unknown>;
  readonly emitted: Set<string>;
  readonly messages: Map<string, SessionMessageInfo>;
  pendingInteractions?: Map<string, ProviderRuntimeEvent>;
  runtimeState?: {
    signature: string;
    sequence: number;
    state?: "error" | "running" | "waiting" | "ready";
  };
  finalEvents?: ProviderRuntimeEvent[];
  lossPending?: boolean;
  finalPublication?: {
    eventId: string;
    operation: Promise<void>;
    state: "pending" | "succeeded" | "failed";
  };
}

export interface V2SessionResources {
  readonly renewCanonicalAuth?: () => Promise<void>;
  readonly activateCanonicalTools?: () => Promise<
    Pick<V2SessionResources, "orchestration" | "cleanup" | "renewCanonicalAuth">
  >;
  /** A shutdown signal bounds the retirement and swallows its failure (records stay recoverable). */
  onThreadToolsCleanup?: (shutdown?: AbortSignal) => Promise<void>;
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
export interface V2IsolatedRuntimeOptions<C extends V2ProcessConfig = V2ProcessConfig> {
  readonly nativeSubagents?: {
    readonly stateDirectory: string;
    readonly qualification?: import("./Runtime.family.ts").V2SubagentQualification;
    readonly prepare?: (
      owner: V2RuntimeSession,
      runtime: import("./Runtime.ts").OpencodeV2Runtime,
    ) => Promise<import("./Runtime.family.ts").V2SubagentQualification | undefined>;
  };
  readonly profileIssuer?: () => Promise<string>;
  readonly activation?: {
    readonly coordinator: import("./PluginSetup.activation.ts").V2ThreadToolsActivation;
    readonly beforeSharedHistory?: (scope: {
      storageIdentity: string;
      nativeSessionId: string;
      threadId: string;
      directory: string;
      /** Native access for dead-backend retirement of a provably dead previous owner. */
      client?: import("./Client.ts").OpencodeV2Client;
      transport?: string;
    }) => Promise<void>;
    readonly awaitReady: (
      client: import("./Client.ts").OpencodeV2Client,
      directory: string,
      signal: AbortSignal | undefined,
      hidden: boolean,
      identity?: import("./Orchestration.selection.ts").V2SessionRegistrationIdentity,
    ) => Promise<{
      gate: import("./PluginSetup.activation.gate.ts").V2ActivationGate;
      stamp: import("./PluginSetup.activation.gate.ts").V2ReadyStamp;
    }>;
  };
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
  readonly threadBridge?: Pick<
    import("./Orchestration.bridge.ts").V2ThreadBridge,
    "attach" | "ensure" | "reply" | "close"
  >;
  readonly threadToolsPreflight?: (
    client: import("./Client.ts").OpencodeV2Client,
    directory: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly manager: OpencodeV2ServerManager;
  readonly config: C;
  readonly journal: ProviderTurnAdmissionsShape;
  readonly sharedBindings?: import("../../../persistence/Services/OpencodeV2SharedBindings.ts").OpencodeV2SharedBindingsShape;
  readonly consent?: import("./Application.consent.ts").V2ConsentAuthority;
  readonly emit: (event: ProviderRuntimeEvent, validate?: () => void) => Promise<void>;
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
