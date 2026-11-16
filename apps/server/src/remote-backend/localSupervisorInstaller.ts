import { makeRemoteAgentAdmission } from "../remote-agent/remoteAgentAdmission.ts";
import {
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentArtifact,
} from "../remote-agent/remoteAgentArtifact.ts";
import { downloadRemoteAgentArtifact } from "../remote-agent/remoteAgentArtifactDownload.ts";
import type { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import { buildRemoteAgentIdentityProbeCommand } from "../remote-agent/remoteAgentConnection.identity.ts";
import {
  parseRemoteAgentCheckOutput,
  remoteAgentIdentityMatches,
} from "../remote-agent/remoteAgentIdentity.ts";
import {
  buildRemoteAgentInstallScript,
  type RemoteAgentInstallPaths,
} from "../remote-agent/remoteAgentInstall.ts";
import {
  adoptRemoteAgentPlacedArtifact,
  probeRemoteAgentPlacedArtifact,
} from "../remote-agent/remoteAgentInstall.inbox.ts";
import { RemoteAgentStageDefinitiveError } from "../remote-agent/remoteAgentInstall.stage.ts";
import { buildRemoteAgentPreflightScript } from "../remote-agent/remoteAgentInstall.preflight.ts";
import {
  makeRemoteAgentInstallManager,
  type RemoteAgentInstallSource,
} from "../remote-agent/remoteAgentInstallManager.ts";
import type { RemoteAgentConnectionBindings } from "../remote-agent/remoteAgentOwners.ts";
import { parseRemoteAgentPlatformProbe } from "../remote-agent/remoteAgentPlatform.ts";
import {
  remoteAgentRuntimeEqual,
  validateRemoteAgentRuntime,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RunSshCommandInput } from "../ssh/sshProcess.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";

function assertSignedSource(source: RemoteAgentInstallSource) {
  if (source.allowUntrustedDevelopmentArtifact)
    throw new Error("Local supervisor installation requires a signed trusted artifact.");
}

function managedRuntime(runtime: RemoteAgentRuntime) {
  if (runtime.origin !== "managed")
    throw new Error("Local admission requires a managed signed runtime.");
  return validateRemoteAgentRuntime(runtime);
}

function signedRuntime(state: RemoteAgentRegistry, runtime: RemoteAgentRuntime) {
  const verified = managedRuntime(runtime);
  if (
    !state.builds.some(
      (build) =>
        build.authenticated &&
        build.binary === "present" &&
        remoteAgentRuntimeEqual(build.runtime, verified),
    )
  )
    throw new Error("Local admission requires a signed managed registry selection.");
}

/** Reuse signed P4 staging/admission with a local transport; no implicit activation or update. */
export function makeLocalSupervisorInstaller(input: {
  readonly control: LocalSupervisorControl;
  readonly referencedBuildIds?: (target: string) => Promise<ReadonlySet<string>>;
  readonly beginRetirement?: (target: string, generation: string) => Promise<() => void>;
  readonly readArtifactBytes?: (
    artifact: RemoteAgentArtifact,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}) {
  const { control } = input;
  const assertTarget = (target: string | null | undefined) => {
    if (target !== control.targetId)
      throw new Error(
        "The local supervisor installer cannot address another authority or SSH target.",
      );
  };
  const absolutePaths = (paths: RemoteAgentInstallPaths): RemoteAgentInstallPaths => {
    const expand = (value: string) => {
      if (!value.startsWith("$HOME/.bigbud/agent"))
        throw new Error("Unexpected managed install path.");
      return value.replace("$HOME", control.homeDir);
    };
    return {
      root: expand(paths.root),
      binRoot: expand(paths.binRoot),
      stateRoot: expand(paths.stateRoot),
      versionRoot: expand(paths.versionRoot),
      buildRoot: expand(paths.buildRoot),
      installedBinary: expand(paths.installedBinary),
      activeLink: expand(paths.activeLink),
      previousLink: expand(paths.previousLink),
    };
  };
  // These are shared internal command envelopes, not arbitrary SSH invocations. Never call SSH.
  const execute = async (command: RunSshCommandInput) => {
    assertTarget(command.executionTargetId);
    if (
      command.command !== "sh" ||
      command.args?.length !== 2 ||
      command.args[0] !== "-lc" ||
      command.env !== undefined ||
      command.cwd !== undefined ||
      command.allocateTty ||
      command.shellMode
    )
      throw new Error("Unsupported local supervisor command envelope.");
    return control.run(control.targetId, command.args[1]!, {
      ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
      ...(command.signal ? { signal: command.signal } : {}),
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.maxBufferBytes !== undefined ? { maxBufferBytes: command.maxBufferBytes } : {}),
    });
  };
  const artifacts = new Map<string, RemoteAgentArtifact>();
  const manager = makeRemoteAgentInstallManager({
    openControl: control.openControl,
    runRemoteCommand: execute,
    probePlatform: async (target) => {
      assertTarget(target);
      return parseRemoteAgentPlatformProbe(
        (
          await control.run(
            target,
            `printf '%s\\n%s\\n' "$(uname -s)" "$(uname -m)"\n${buildRemoteAgentPreflightScript()}`,
            { timeoutMs: 8000, maxBufferBytes: 4096 },
          )
        ).stdout,
      );
    },
    readArtifactBytes:
      input.readArtifactBytes ??
      ((artifact, signal) => downloadRemoteAgentArtifact(artifact, signal ? { signal } : {})),
    probePlacedArtifact: (target, artifact) =>
      probeRemoteAgentPlacedArtifact(execute, target, artifact),
    adoptPlacedArtifact: async (request) => {
      assertTarget(request.executionTargetId);
      const paths = absolutePaths(await adoptRemoteAgentPlacedArtifact(execute, request));
      artifacts.set(paths.installedBinary, request.artifact);
      return paths;
    },
    installArtifact: async (request) => {
      assertTarget(request.executionTargetId);
      if (request.skipSignatureVerification)
        throw new Error("Unsigned local installation is forbidden.");
      verifyRemoteAgentArtifactSignature(request.artifact, request.trustStore);
      verifyRemoteAgentArtifactBytes(request.artifact, request.bytes);
      const script = buildRemoteAgentInstallScript({
        artifact: request.artifact,
        targetTriple: request.targetTriple,
        stagedBase64: Buffer.from(request.bytes).toString("base64"),
        ...(request.reservationId ? { reservationId: request.reservationId } : {}),
      });
      await control.run(control.targetId, script.command, {
        stdin: script.stdin,
        timeoutMs: 60_000,
        maxBufferBytes: 64 * 1024,
      });
      const paths = absolutePaths(script.paths);
      artifacts.set(paths.installedBinary, request.artifact);
      return paths;
    },
    verifyInstalledAgent: async (request) => {
      assertTarget(request.executionTargetId);
      const artifact = artifacts.get(request.binaryPath);
      artifacts.delete(request.binaryPath);
      if (
        !artifact ||
        (await probeRemoteAgentPlacedArtifact(execute, control.targetId, artifact)) !== "managed"
      )
        throw new RemoteAgentStageDefinitiveError(
          "Installed local supervisor bytes disagree with the signed artifact.",
        );
      const checked = await control.run(
        control.targetId,
        buildRemoteAgentIdentityProbeCommand(request.binaryPath),
        { timeoutMs: 5000, maxBufferBytes: 64 * 1024 },
      );
      try {
        const identity = parseRemoteAgentCheckOutput(checked.stdout);
        const architecture = request.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64";
        if (
          !remoteAgentIdentityMatches(identity, request) ||
          identity.operatingSystem !== "linux" ||
          identity.architecture !== architecture
        )
          throw new Error("Mismatched local supervisor identity.");
      } catch (cause) {
        throw new RemoteAgentStageDefinitiveError(
          "Installed local supervisor check was incompatible.",
          { cause },
        );
      }
    },
    referencedBuildIds: async (target) => {
      assertTarget(target);
      if (!input.referencedBuildIds)
        throw new Error(
          "Local supervisor retirement requires complete durable service and owner references.",
        );
      return input.referencedBuildIds(target);
    },
    beginRetirement: async (target, generation) => {
      assertTarget(target);
      if (!input.beginRetirement)
        throw new Error(
          "Local supervisor live retirement requires the owning connection-pool fence.",
        );
      return input.beginRetirement(target, generation);
    },
  });
  return {
    cleanup: (target: string) => {
      assertTarget(target);
      return manager.cleanup(target);
    },
    install: (request: Parameters<typeof manager.install>[0]) => {
      assertTarget(request.executionTargetId);
      assertSignedSource(request.source);
      return manager.install(request);
    },
    resolveArtifact: (request: Parameters<typeof manager.resolveArtifact>[0]) => {
      assertTarget(request.executionTargetId);
      assertSignedSource(request.source);
      return manager.resolveArtifact({ ...request, verifySignature: true });
    },
    createAdmission: (
      bindings: RemoteAgentConnectionBindings,
      connect: (
        target: string,
        runtime: RemoteAgentRuntime,
      ) => RemoteAgentConnection | Promise<RemoteAgentConnection>,
    ) => {
      const guardedBindings: RemoteAgentConnectionBindings = {
        ...bindings,
        getBinding: async (target) => {
          assertTarget(target);
          const retained = await bindings.getBinding(target);
          if (retained) managedRuntime(retained.runtime);
          return retained;
        },
      };
      const checkedConnect = async (target: string, runtime: RemoteAgentRuntime) => {
        assertTarget(target);
        managedRuntime(runtime);
        signedRuntime(await (await control.openControl(target)).registry.read(), runtime);
        await verifyManagedLocalSupervisor(runtime);
        return connect(target, runtime);
      };
      const admission = makeRemoteAgentAdmission({
        bindings: guardedBindings,
        control: control.openControl,
        connect: checkedConnect,
      });
      return {
        status: (...args: Parameters<typeof admission.status>) => {
          assertTarget(args[0]);
          return admission.status(...args);
        },
        resolveBinding: async (target: string) => {
          assertTarget(target);
          const retained = await guardedBindings.getBinding(target);
          const opened = await control.openControl(target);
          const state = await opened.registry.read();
          if (!state.current) return undefined;
          const selected = state.builds.find((build) => build.id === state.current);
          if (!selected) throw new Error("Managed local registry selection is missing.");
          signedRuntime(state, selected.runtime);
          if (retained) signedRuntime(state, retained.runtime);
          // Reuse generic ready-binding admission against this checked snapshot. A second mutable
          // registry/binding read must never turn this operation into a legacy executable probe.
          return makeRemoteAgentAdmission({
            bindings: { ...guardedBindings, getBinding: async () => retained },
            control: async () => ({
              ...opened,
              registry: { ...opened.registry, read: async () => state },
            }),
            connect: checkedConnect,
          }).resolveBinding(target);
        },
        verify: (...args: Parameters<typeof admission.verify>) => {
          assertTarget(args[0]);
          managedRuntime(args[1]);
          return admission.verify(...args);
        },
        fresh: (...args: Parameters<typeof admission.fresh>) => {
          assertTarget(args[0]);
          throw new Error("Local supervisor launch requires a separately owned service transport.");
        },
      };
    },
  };
}
