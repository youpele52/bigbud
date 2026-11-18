import {
  parseRemoteAgentArtifactManifest,
  remoteAgentTargetCandidates,
  selectRemoteAgentArtifact,
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentArtifact,
  type RemoteAgentArtifactManifest,
  type RemoteAgentArtifactTrustStore,
  type RemoteAgentTargetTriple,
} from "./remoteAgentArtifact.ts";
import { installRemoteAgentArtifact, type RemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import { openRemoteAgentControl, type RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  RemoteAgentStageDefinitiveError,
  stageRemoteAgentBuild,
} from "./remoteAgentInstall.stage.ts";
import { cleanupRemoteAgentBuilds } from "./remoteAgentInstall.cleanup.ts";
import { prepareRemoteAgentInstallCapacity } from "./remoteAgentInstall.capacity.ts";
import { remoteAgentRuntimeSummary } from "./remoteAgentStatus.ts";
import { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.ts";
import { probeRemoteAgentPlatform, type RemoteAgentPlatformInfo } from "./remoteAgentPlatform.ts";
import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import { parseRemoteAgentCheckOutput, remoteAgentIdentityMatches } from "./remoteAgentIdentity.ts";
import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";
import {
  RemoteAgentRemoteCommandError,
  runRemoteAgentDiagnosedCommand,
} from "./remoteAgentDiagnostics.ts";
import {
  adoptRemoteAgentPlacedArtifact,
  probeRemoteAgentPlacedArtifact,
  type RemoteAgentPlacedState,
} from "./remoteAgentInstall.inbox.ts";
import { assertRemoteAgentPreflight } from "./remoteAgentInstall.preflight.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";

export class RemoteAgentInstallManagerError extends Error {
  readonly _tag = "RemoteAgentInstallManagerError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentInstallManagerError";
  }
}

export interface RemoteAgentInstallSource {
  readonly manifest: RemoteAgentArtifactManifest;
  readonly trustStore: RemoteAgentArtifactTrustStore;
  readonly allowUntrustedDevelopmentArtifact?: true;
}

export interface RemoteAgentInstallResult {
  readonly runtimeSummary: ReturnType<typeof remoteAgentRuntimeSummary>;
  readonly status: "staged";
  /** Where verified bytes came from: uploaded, already managed, or the manual inbox. */
  readonly placement: "upload" | "managed" | "inbox";
  /** A manual inbox candidate exists for this digest but does not match the signed build. */
  readonly inboxConflict: boolean;
  readonly platform: RemoteAgentPlatformInfo;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly artifact: RemoteAgentArtifact;
  readonly paths: RemoteAgentInstallPaths;
  /** Remote shell path understood by RemoteAgentConnection.ssh. */
  readonly binaryPath: string;
}

export interface RemoteAgentResolvedArtifact {
  readonly platform: RemoteAgentPlatformInfo;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly artifact: RemoteAgentArtifact;
}

interface RemoteAgentInstallManagerDependencies {
  readonly openControl: (executionTargetId: string) => Promise<RemoteAgentControl>;
  readonly probePlatform: (executionTargetId: string) => Promise<RemoteAgentPlatformInfo>;
  readonly readArtifactBytes: (
    artifact: RemoteAgentArtifact,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly installArtifact: (input: {
    readonly executionTargetId: string;
    readonly artifact: RemoteAgentArtifact;
    readonly targetTriple: RemoteAgentTargetTriple;
    readonly bytes: Uint8Array;
    readonly trustStore: RemoteAgentArtifactTrustStore;
    readonly skipSignatureVerification?: boolean;
    readonly reservationId?: string;
  }) => Promise<RemoteAgentInstallPaths>;
  readonly runRemoteCommand: (input: RunSshCommandInput) => Promise<unknown>;
  readonly probePlacedArtifact: (
    executionTargetId: string,
    artifact: RemoteAgentArtifact,
  ) => Promise<RemoteAgentPlacedState>;
  readonly adoptPlacedArtifact: (input: {
    readonly executionTargetId: string;
    readonly artifact: RemoteAgentArtifact;
    readonly targetTriple: RemoteAgentTargetTriple;
    readonly reservationId?: string;
  }) => Promise<RemoteAgentInstallPaths>;
  readonly verifyInstalledAgent: (input: {
    readonly binaryPath: string;
    readonly targetTriple: RemoteAgentTargetTriple;
    readonly executionTargetId: string;
    readonly version: string;
    readonly buildDigest: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  }) => Promise<void>;
  readonly beginRetirement?: (executionTargetId: string, generation: string) => Promise<() => void>;
  readonly referencedBuildIds?: (executionTargetId: string) => Promise<ReadonlySet<string>>;
}

function defaultDependencies(
  runRemoteCommand: (input: RunSshCommandInput) => Promise<unknown>,
): RemoteAgentInstallManagerDependencies {
  return {
    openControl: (executionTargetId) => openRemoteAgentControl(executionTargetId, runRemoteCommand),
    probePlatform: probeRemoteAgentPlatform,
    readArtifactBytes: (artifact, signal) =>
      downloadRemoteAgentArtifact(artifact, signal ? { signal } : {}),
    installArtifact: installRemoteAgentArtifact,
    runRemoteCommand,
    probePlacedArtifact: (executionTargetId, artifact) =>
      probeRemoteAgentPlacedArtifact(runRemoteCommand, executionTargetId, artifact).catch(
        (cause: unknown) => {
          // Placement is an optimisation: a failed probe falls back to the verified upload.
          if (cause instanceof RemoteAgentRemoteCommandError) return "absent" as const;
          throw cause;
        },
      ),
    adoptPlacedArtifact: (input) => adoptRemoteAgentPlacedArtifact(runRemoteCommand, input),
    verifyInstalledAgent: async (input) => {
      const { stdout } = await runRemoteAgentDiagnosedCommand(runRemoteCommand, "check", {
        executionTargetId: input.executionTargetId,
        command: "sh",
        args: ["-lc", buildRemoteAgentIdentityProbeCommand(input.binaryPath)],
        timeoutMs: 30_000,
        maxBufferBytes: 64 * 1024,
      });
      try {
        const identity = parseRemoteAgentCheckOutput(stdout);
        const architecture = input.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64";
        if (
          !remoteAgentIdentityMatches(identity, input) ||
          identity.operatingSystem !== "linux" ||
          identity.architecture !== architecture
        ) {
          throw new RemoteAgentInstallManagerError(
            "Installed remote agent candidate returned an invalid handshake.",
          );
        }
      } catch (cause) {
        throw new RemoteAgentStageDefinitiveError(
          "Installed remote agent candidate returned an invalid check.",
          { cause },
        );
      }
    },
  };
}

export function makeRemoteAgentInstallManager(
  overrides: Partial<RemoteAgentInstallManagerDependencies> = {},
) {
  const dependencies = {
    ...defaultDependencies(overrides.runRemoteCommand ?? runSshCommand),
    ...overrides,
  };
  const installTails = new Map<string, Promise<void>>();

  const withInstallLock = async <A>(executionTargetId: string, run: () => Promise<A>) => {
    const previous = installTails.get(executionTargetId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    installTails.set(executionTargetId, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (installTails.get(executionTargetId) === tail) {
        installTails.delete(executionTargetId);
      }
    }
  };

  const resolveArtifact = async (input: {
    readonly executionTargetId: string;
    readonly source: RemoteAgentInstallSource;
    readonly verifySignature?: boolean;
  }): Promise<RemoteAgentResolvedArtifact> => {
    const platform = await dependencies.probePlatform(input.executionTargetId);
    if (!platform.targetTriple) {
      throw new RemoteAgentInstallManagerError(
        `Remote agent is unsupported on ${platform.operatingSystem}/${platform.architecture}.`,
      );
    }
    // Prefer the static musl build when published; glibc remains for transition manifests.
    const artifact = selectRemoteAgentArtifact(
      input.source.manifest,
      remoteAgentTargetCandidates(platform.targetTriple, platform.preflight?.libc.family),
    );
    if (input.verifySignature && !input.source.allowUntrustedDevelopmentArtifact) {
      verifyRemoteAgentArtifactSignature(artifact, input.source.trustStore);
    }
    return { platform, targetTriple: artifact.targetTriple, artifact };
  };

  return {
    resolveArtifact,
    cleanup: async (executionTargetId: string) => {
      const control = await dependencies.openControl(executionTargetId);
      let referencedBuildIds: (() => Promise<ReadonlySet<string>>) | undefined;
      if (dependencies.referencedBuildIds) {
        referencedBuildIds = () => dependencies.referencedBuildIds!(executionTargetId);
      } else {
        try {
          const owners = remoteAgentOwners();
          referencedBuildIds = () => owners.referencedBuildIds(executionTargetId);
        } catch {
          // Standalone install-manager tests and pre-persistence bootstrap have no local owner store.
        }
      }
      return cleanupRemoteAgentBuilds(control, referencedBuildIds, executionTargetId);
    },
    install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
      readonly signal?: AbortSignal;
    }): Promise<RemoteAgentInstallResult> =>
      withInstallLock(input.executionTargetId, async () => {
        if (input.signal?.aborted) {
          throw input.signal.reason ?? new DOMException("caller", "AbortError");
        }
        const { platform, targetTriple, artifact } = await resolveArtifact({
          ...input,
          verifySignature: true,
        });
        // Refuse before downloading or uploading when the host cannot install or run the build.
        if (platform.preflight) assertRemoteAgentPreflight(platform.preflight);
        // Pre-placed managed or inbox bytes skip the download and upload entirely.
        const placed = await dependencies.probePlacedArtifact(input.executionTargetId, artifact);
        const adopt = placed === "managed" || placed === "inbox";
        const bytes = adopt ? null : await dependencies.readArtifactBytes(artifact, input.signal);
        if (bytes) verifyRemoteAgentArtifactBytes(artifact, bytes);
        if (input.signal?.aborted) {
          throw input.signal.reason ?? new DOMException("caller", "AbortError");
        }
        const control = await dependencies.openControl(input.executionTargetId);
        const paths = await stageRemoteAgentBuild({
          control,
          artifact,
          authenticated: !input.source.allowUntrustedDevelopmentArtifact,
          ...(input.signal ? { signal: input.signal } : {}),
          prepareCapacity: async (capacity) => {
            let referencedBuildIds: (() => Promise<ReadonlySet<string>>) | undefined;
            if (dependencies.referencedBuildIds) {
              referencedBuildIds = () => dependencies.referencedBuildIds!(input.executionTargetId);
            } else {
              try {
                const owners = remoteAgentOwners();
                referencedBuildIds = () => owners.referencedBuildIds(input.executionTargetId);
              } catch {
                // Capacity reclamation requires durable local owner evidence.
              }
            }
            return prepareRemoteAgentInstallCapacity({
              target: input.executionTargetId,
              control: capacity.control,
              build: capacity.build,
              inventory: capacity.inventory,
              ...(referencedBuildIds ? { referencedBuildIds } : {}),
              ...(dependencies.beginRetirement
                ? {
                    beginRetirement: (generation) =>
                      dependencies.beginRetirement!(input.executionTargetId, generation),
                  }
                : {}),
            });
          },
          installAndCheck: async (binaryPath, reservationId) => {
            const installed = bytes
              ? await dependencies.installArtifact({
                  executionTargetId: input.executionTargetId,
                  artifact,
                  targetTriple,
                  bytes,
                  trustStore: input.source.trustStore,
                  ...(input.source.allowUntrustedDevelopmentArtifact
                    ? { skipSignatureVerification: true }
                    : {}),
                  reservationId,
                })
              : await dependencies.adoptPlacedArtifact({
                  executionTargetId: input.executionTargetId,
                  artifact,
                  targetTriple,
                  reservationId,
                });
            await dependencies.verifyInstalledAgent({
              executionTargetId: input.executionTargetId,
              binaryPath,
              targetTriple,
              version: artifact.version,
              buildDigest: artifact.buildDigest,
              protocolMajor: artifact.protocolMajor,
              protocolMinor: artifact.protocolMinor,
            });
            return installed;
          },
        });
        return {
          runtimeSummary: remoteAgentRuntimeSummary(await control.registry.read()),
          status: "staged",
          placement: adopt ? placed : "upload",
          inboxConflict: placed === "inbox-conflict",
          platform,
          targetTriple,
          artifact,
          paths,
          binaryPath: paths.installedBinary,
        };
      }),
  };
}

export function parseRemoteAgentInstallSource(value: unknown): RemoteAgentInstallSource {
  if (typeof value !== "object" || value === null) {
    throw new RemoteAgentInstallManagerError("Remote agent install source must be an object.");
  }
  const source = value as { manifest?: unknown; trustStore?: unknown };
  if (!source.trustStore || typeof source.trustStore !== "object") {
    throw new RemoteAgentInstallManagerError("Remote agent install trust store is required.");
  }
  return {
    manifest: parseRemoteAgentArtifactManifest(source.manifest),
    trustStore: source.trustStore as RemoteAgentArtifactTrustStore,
  };
}
