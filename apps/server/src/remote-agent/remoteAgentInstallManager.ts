import {
  parseRemoteAgentArtifactManifest,
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
import { prepareRemoteAgentPredecessorRetirement } from "./remoteAgentInstall.retirement.ts";
import { remoteAgentRuntimeSummary } from "./remoteAgentStatus.ts";
import { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.ts";
import { probeRemoteAgentPlatform, type RemoteAgentPlatformInfo } from "./remoteAgentPlatform.ts";
import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import { parseRemoteAgentCheckOutput, remoteAgentIdentityMatches } from "./remoteAgentIdentity.ts";
import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";
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

function remoteCommandStdout(result: unknown): string {
  return typeof result === "object" && result !== null && "stdout" in result
    ? String((result as { stdout?: unknown }).stdout ?? "")
    : "";
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
    verifyInstalledAgent: async (input) => {
      const result = await runRemoteCommand({
        executionTargetId: input.executionTargetId,
        command: "sh",
        args: ["-lc", buildRemoteAgentIdentityProbeCommand(input.binaryPath)],
        timeoutMs: 30_000,
        maxBufferBytes: 64 * 1024,
        outputMode: "error",
      });
      try {
        const stdout = remoteCommandStdout(result);
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
    const artifact = selectRemoteAgentArtifact(input.source.manifest, platform.targetTriple);
    if (input.verifySignature && !input.source.allowUntrustedDevelopmentArtifact) {
      verifyRemoteAgentArtifactSignature(artifact, input.source.trustStore);
    }
    return { platform, targetTriple: platform.targetTriple, artifact };
  };

  return {
    resolveArtifact,
    cleanup: async (executionTargetId: string) => {
      const control = await dependencies.openControl(executionTargetId);
      let referencedBuildIds: (() => Promise<ReadonlySet<string>>) | undefined;
      try {
        const owners = remoteAgentOwners();
        referencedBuildIds = () => owners.referencedBuildIds(executionTargetId);
      } catch {
        // Standalone install-manager tests and pre-persistence bootstrap have no local owner store.
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
        const bytes = await dependencies.readArtifactBytes(artifact, input.signal);
        verifyRemoteAgentArtifactBytes(artifact, bytes);
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
            return prepareRemoteAgentPredecessorRetirement({
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
            const installed = await dependencies.installArtifact({
              executionTargetId: input.executionTargetId,
              artifact,
              targetTriple,
              bytes,
              trustStore: input.source.trustStore,
              ...(input.source.allowUntrustedDevelopmentArtifact
                ? { skipSignatureVerification: true }
                : {}),
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
