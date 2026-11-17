import { RemoteBackendDeploymentError } from "@bigbud/contracts/server/remoteBackendDeployment.ts";
import type { RemoteBackendProfileRecord } from "../persistence/Services/RemoteBackendProfiles.ts";
import type { BackendGraphManifest } from "./backendGraph.manifest.ts";

export type DeploymentErrorCode = RemoteBackendDeploymentError["code"];
export const deploymentError = (
  code: DeploymentErrorCode,
  message: string,
  reason?: RemoteBackendDeploymentError["reason"],
) => new RemoteBackendDeploymentError({ code, message, ...(reason ? { reason } : {}) });

/** One remote command. Scripts are fixed application constants; arguments are validated values. */
export interface DeploymentRemoteCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: { readonly text: string } | { readonly path: string };
  readonly timeoutMs: number;
}
export interface DeploymentRemoteResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
/** Production: SSH `clean-posix` with strict host keys. Tests: a local process in a private HOME. */
export type DeploymentRemoteRunner = (
  executionTargetId: string,
  command: DeploymentRemoteCommand,
  signal: AbortSignal,
) => Promise<DeploymentRemoteResult>;

/** A signed graph selected for one target triple, pinned by its archive sha256. */
export interface DeploymentGraphSource {
  readonly origin: "release" | "local";
  readonly manifest: BackendGraphManifest;
  readonly manifestJson: string;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  /** HTTPS asset the VPS downloads with curl. Absent for a local dev graph. */
  readonly archiveUrl?: string;
  /** Laptop-side bytes for the SSH stdin fallback; verified against the pin before upload. */
  readonly materializeArchive: (signal: AbortSignal) => Promise<{
    readonly path: string;
    readonly release: () => Promise<void>;
  }>;
  /** Pinned PUBLIC keys handed to `backend setup` (graph and Rust manifest signers). */
  readonly trustedKeys: Readonly<Record<string, string>>;
  /** Signed Rust artifact manifest JSON for `backend setup --rust-manifest`. */
  readonly rustManifestJson: string;
}
export type DeploymentGraphSourceResolver = (
  target: "aarch64-unknown-linux-gnu" | "x86_64-unknown-linux-gnu",
  signal: AbortSignal,
) => Promise<DeploymentGraphSource>;

export interface DeploymentApproval {
  readonly approved: boolean;
  readonly hostTrustFailure?: string;
}

/** Promise view of the persisted profile repository used by the deployment core. */
export interface DeploymentProfileStore {
  readonly list: () => Promise<ReadonlyArray<RemoteBackendProfileRecord>>;
  readonly get: (profileId: string) => Promise<RemoteBackendProfileRecord | undefined>;
  readonly findByRequestId: (requestId: string) => Promise<RemoteBackendProfileRecord | undefined>;
  readonly findByTarget: (
    executionTargetId: string,
  ) => Promise<RemoteBackendProfileRecord | undefined>;
  readonly insert: (record: RemoteBackendProfileRecord) => Promise<RemoteBackendProfileRecord>;
}

export const DEPLOYMENT_REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const REMOTE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/@+-]{0,4095}$/;
export const RELAY_HELPER_NAME = "remote-client-relay/remoteBackendClientRelay.mjs";
