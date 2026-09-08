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
import {
  buildRemoteAgentCandidateCheckScript,
  installRemoteAgentArtifact,
  type RemoteAgentInstallPaths,
} from "./remoteAgentInstall.ts";
import { runRemoteAgentActivationTransaction } from "./remoteAgentInstall.transaction.ts";
import { probeRemoteAgentPlatform, type RemoteAgentPlatformInfo } from "./remoteAgentPlatform.ts";
import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import { parseRemoteAgentCheckOutput, remoteAgentIdentityMatches } from "./remoteAgentIdentity.ts";
import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";

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
  }) => Promise<RemoteAgentInstallPaths>;
  readonly runRemoteCommand: (input: RunSshCommandInput) => Promise<unknown>;
  readonly verifyInstalledAgent: (input: {
    readonly executionTargetId: string;
    readonly version: string;
    readonly buildDigest: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  }) => Promise<void>;
}

function defaultDependencies(
  runRemoteCommand: (input: RunSshCommandInput) => Promise<unknown>,
): RemoteAgentInstallManagerDependencies {
  return {
    probePlatform: probeRemoteAgentPlatform,
    readArtifactBytes: (artifact, signal) =>
      downloadRemoteAgentArtifact(artifact, signal ? { signal } : {}),
    installArtifact: installRemoteAgentArtifact,
    runRemoteCommand,
    verifyInstalledAgent: async (input) => {
      const result = await runRemoteCommand({
        executionTargetId: input.executionTargetId,
        command: "sh",
        args: ["-lc", buildRemoteAgentCandidateCheckScript()],
        timeoutMs: 30_000,
        maxBufferBytes: 64 * 1024,
        outputMode: "error",
      });
      const stdout = remoteCommandStdout(result);
      if (!remoteAgentIdentityMatches(parseRemoteAgentCheckOutput(stdout), input)) {
        throw new RemoteAgentInstallManagerError(
          "Installed remote agent candidate returned an invalid handshake.",
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
        const paths = await dependencies.installArtifact({
          executionTargetId: input.executionTargetId,
          artifact,
          targetTriple,
          bytes,
          trustStore: input.source.trustStore,
          ...(input.source.allowUntrustedDevelopmentArtifact
            ? { skipSignatureVerification: true }
            : {}),
        });
        try {
          await runRemoteAgentActivationTransaction({
            executionTargetId: input.executionTargetId,
            artifact,
            paths,
            runRemoteCommand: dependencies.runRemoteCommand,
            verifyInstalledAgent: dependencies.verifyInstalledAgent,
          });
        } catch (error) {
          throw new RemoteAgentInstallManagerError(
            error instanceof Error ? error.message : String(error),
          );
        }
        return {
          platform,
          targetTriple,
          artifact,
          paths,
          binaryPath: paths.activeLink,
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
