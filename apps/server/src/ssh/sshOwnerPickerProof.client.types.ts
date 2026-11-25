import type { CodexSshOwner } from "../codex/codexAppServerManager.process.remote.owner.ts";
import type { PiRpcOwner } from "../provider/Layers/Pi/RpcProcess.owner.ts";
import type { OpencodeSshOwner } from "../provider/Layers/Opencode/ServerManager.owner.ts";
import type { RemoteAgentProxyLease } from "../remote-agent/remoteAgentConnection.owner.ts";
import type { ClientRelaySshOwner } from "../remote-backend/clientRelay.ssh.owner.ts";
import type { PeerRelaySshOwner } from "../remote-backend/peerRelay.ssh.owner.ts";
import type { PickerProofAttachment } from "./sshOwnerPickerProof.attachment.ts";
import type { PickerProofAgentProxyInput } from "./sshOwnerPickerProof.client.agentProxy.ts";
import type { PickerProofAgentActionInput } from "./sshOwnerPickerProof.client.agentAction.ts";
import type { AgentActionResult } from "./sshOwnerPickerProof.codec.agentAction.ts";
import type { PickerProofAliasConfig } from "./sshOwnerPickerProof.client.alias.ts";
import type { ScopedProofStartupOptions } from "./sshOwnerPickerProof.client.scopedStartup.ts";
import type {
  makeProofGitAdvertisement,
  makeProofGitUpload,
} from "./sshOwnerPickerProof.client.scopedDuplex.ts";
import type {
  PickerProofOwner,
  PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.types.ts";
import type { PickerProofAgentFixture } from "./sshOwnerPickerProof.codec.agentProxy.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { PickerProofProviderFixture } from "./sshOwnerPickerProof.codec.provider.ts";
import type { ClientRelayDeployment } from "../remote-backend/clientRelay.ssh.owner.ts";

export interface PickerProofOwnerOptions
  extends PickerProofSessionOptions, ScopedProofStartupOptions {
  readonly binary: string;
  readonly lockFile: string;
  readonly sshBinary: string;
  readonly keyscanBinary: string;
  /**
   * Fixture target facts. A production owner starts without a target, so these
   * are absent there and every target comes from a request descriptor.
   */
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly identityFile?: string;
  readonly knownHostsFile?: string;
  readonly aliasConfig?: PickerProofAliasConfig;
  readonly attachment?: PickerProofAttachment;
  readonly workspaceRoot?: string;
  readonly devInteractiveTerminal?: boolean;
  readonly agentProxyFixture?: PickerProofAgentFixture;
  readonly clientRelayFixture?: ClientRelayDeployment;
  readonly codexFixture?: PickerProofProviderFixture;
  /** Product provider service: owner-selected executable and fixed recipe. */
  readonly providerService?: {
    readonly kind: "pi" | "codex";
    readonly binaryPath: string;
  };
  /** Product OpenCode v1 service: the only owner-selected forwarding authority. */
  readonly opencodeService?: { readonly binaryPath: string };
  /**
   * Production only: owner-selected installed agent used by per-target proxy
   * leases. The owner validates the digest and state directory itself.
   */
  readonly agentService?: {
    readonly binaryPath: string;
    readonly sha256: string;
    readonly stateDir: string;
  };
  readonly piFixture?: PickerProofProviderFixture;
  readonly opencodeFixture?: PickerProofProviderFixture;
  readonly identityAgentPath?: string;
  /** Startup-bound Linux proof, never derived from an operation or renderer input. */
  readonly installedAgentStateDir?: string;
  /**
   * Production launch only: use the cleared environment allowlist and bound the
   * handshake. Callers never supply the executable, argv or environment.
   */
  readonly productionLaunch?: {
    readonly startupDeadlineMs: number;
    /** `bbso1:<kind>:<hex>`; the owner validates it against `stateDirectory`. */
    readonly profileBindingText: string;
    readonly stateDirectory: string;
  };
}

export type PickerProofAttachOptions = PickerProofSessionOptions & PickerProofAttachment;

export interface LaunchedPickerProofOwner
  extends PickerProofOwner, ClientRelaySshOwner, CodexSshOwner {
  readonly piRpcOwner: PiRpcOwner;
  readonly opencodeOwner?: OpencodeSshOwner;
  readonly openPeerRelay: PeerRelaySshOwner["openPeerRelay"];
  readonly openGitAdvertisement: ReturnType<typeof makeProofGitAdvertisement>;
  readonly openGitUpload: ReturnType<typeof makeProofGitUpload>;
  openProofAgentProxy(
    input: PickerProofAgentProxyInput,
    signal?: AbortSignal,
  ): Promise<RemoteAgentProxyLease>;
  /** Enum-verb owner recipes; no caller command, arguments, cwd or environment. */
  runAgentAction(input: PickerProofAgentActionInput): Promise<AgentActionResult>;
  detach(): Promise<void>;
  retireSupervised(): Promise<void>;
  /** Kills the exact spawned child; production maps this to `reap`. */
  retireSpawned(): Promise<void>;
  killForTest(): Promise<void>;
  /** Proof-only: issue a grant without executing; returns the typed error number. */
  issueProofGrantForTest(operation: PickerProofOperation): Promise<number | undefined>;
}
