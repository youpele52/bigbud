import { userInfo, platform, arch } from "node:os";
import {
  makeLocalSupervisorControl,
  type LocalSupervisorControl,
} from "./localSupervisorControl.ts";
import { scopeLocalSupervisorControl } from "./localSupervisorControl.scope.ts";
import { claimLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { makeLocalSupervisorInstaller } from "./localSupervisorInstaller.ts";
import {
  prepareManagedLocalSupervisorRuntime,
  verifyManagedLocalSupervisor,
} from "./localSupervisorBinary.ts";
import { makeLocalSupervisorServiceLauncher } from "./localSupervisorService.launch.ts";
import { connectLocalSupervisorProxy } from "./localSupervisorTransport.ts";
import { prepareStagedRemoteAgentCandidate } from "../remote-agent/remoteAgentUpdate.prepare.ts";
import { makeRemoteAgentAdmission } from "../remote-agent/remoteAgentAdmission.ts";
import {
  remoteAgentBuildId,
  remoteAgentRuntimeEqual,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import { remoteAgentTargetCandidates } from "@bigbud/shared/remoteAgentArtifact";
import { quoteRemoteAgentLaunchValue as quote } from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";
import type {
  RemoteAgentInstallResult,
  RemoteAgentInstallSource,
} from "../remote-agent/remoteAgentInstallManager.ts";
import type { LocalSupervisorPreflightContext } from "./localSupervisorService.preflight.ts";
import type { SetupAccount } from "./localSupervisorService.setup.validation.ts";
export interface LocalSupervisorServiceSetupDependencies {
  readonly account: () => SetupAccount;
  readonly control: (home: string, target: string, signal: AbortSignal) => LocalSupervisorControl;
  readonly claim: typeof claimLocalSupervisorAuthorityReservation;
  readonly install: (
    control: LocalSupervisorControl,
    source: RemoteAgentInstallSource,
    signal: AbortSignal,
  ) => Promise<RemoteAgentRuntime>;
  readonly admit: (
    context: LocalSupervisorPreflightContext,
    control: LocalSupervisorControl,
    runtime: RemoteAgentRuntime,
    configPath: string,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<string>;
}
/**
 * D3: the backend graph is glibc-only, but the Rust launcher ships static musl. A gnu graph
 * therefore accepts the host's musl or gnu launcher; signature, bytes and `--check` identity
 * stay enforced by the installer and the capability probe below.
 */
export function assertSetupRuntimeTarget(
  result: Pick<RemoteAgentInstallResult, "platform" | "artifact">,
): void {
  const { platform, artifact } = result;
  const libc = platform.preflight?.libc.family ?? "unknown";
  if (platform.operatingSystem !== "linux" || !platform.targetTriple || libc === "musl")
    throw new Error("The backend tier requires a glibc Linux host; the Rust-only tier remains.");
  if (!remoteAgentTargetCandidates(platform.targetTriple, libc).includes(artifact.targetTriple))
    throw new Error("The signed Rust artifact does not run on this Linux account platform.");
}
async function install(
  control: LocalSupervisorControl,
  source: RemoteAgentInstallSource,
  signal: AbortSignal,
) {
  const result = await makeLocalSupervisorInstaller({ control }).install({
    executionTargetId: control.targetId,
    source,
    signal,
  });
  assertSetupRuntimeTarget(result);
  const state = await (await control.openControl(control.targetId)).registry.read();
  const id = `${result.artifact.version}:${result.artifact.sha256}:${result.artifact.targetTriple}`;
  const build = state.builds.find((entry) => entry.id === id);
  if (
    !build?.authenticated ||
    build.binary !== "present" ||
    build.runtime.origin !== "managed" ||
    build.runtime.buildDigest !== result.artifact.buildDigest
  )
    throw new Error("Signed P4 staging did not publish the selected immutable managed runtime.");
  await prepareManagedLocalSupervisorRuntime(build.runtime, signal);
  await verifyManagedLocalSupervisor(build.runtime);
  const capability = (
    await control.run(
      control.targetId,
      `${quote(build.runtime.binaryPath)} --check --capabilities`,
      { timeoutMs: 5000, maxBufferBytes: 4096, signal },
    )
  ).stdout.split(/\s+/);
  if (!capability.includes("backend-service=2") || !capability.includes("backend-service-graph=1"))
    throw new Error("The selected signed Rust runtime lacks complete backend graph enforcement.");
  return build.runtime;
}
async function admit(
  context: LocalSupervisorPreflightContext,
  control: LocalSupervisorControl,
  runtime: RemoteAgentRuntime,
  configPath: string,
  requestId: string,
  signal: AbortSignal,
) {
  const target = control.targetId,
    opened = await control.openControl(target);
  const launcher = makeLocalSupervisorServiceLauncher({ control, configPath, signal });
  const connections = new Set<Awaited<ReturnType<typeof connectLocalSupervisorProxy>>>();
  const close = () => {
    for (const connection of connections) {
      try {
        connection.disconnect(new Error("Finite account setup was cancelled."));
      } catch {
        /* Confirmed cleanup below remains mandatory. */
      }
    }
  };
  signal.addEventListener("abort", close, { once: true });
  const connect = async (selected: string, pinned: RemoteAgentRuntime) => {
    signal.throwIfAborted();
    if (selected !== target || !remoteAgentRuntimeEqual(pinned, runtime))
      throw new Error("Setup cannot connect to another runtime or authority.");
    const connection = await connectLocalSupervisorProxy(pinned);
    connections.add(connection);
    if (signal.aborted) {
      connection.close();
      signal.throwIfAborted();
    }
    return connection;
  };
  let outcome: { readonly value: string } | { readonly cause: unknown } | undefined;
  let cleanupFailures: unknown[] = [];
  try {
    const epoch = await prepareStagedRemoteAgentCandidate({
      target,
      requestId: `setup-${requestId}`,
      buildId: remoteAgentBuildId(runtime),
      control: opened,
      launch: launcher.launch,
      connect,
    });
    signal.throwIfAborted();
    const admission = makeRemoteAgentAdmission({
      bindings: context.owners,
      control: control.openControl,
      connect,
    });
    await admission.fresh(target, `setup-admit-${requestId}`, {
      requestedBuildId: remoteAgentBuildId(runtime),
    });
    signal.throwIfAborted();
    const binding = await context.owners.getBinding(target);
    if (
      !binding ||
      binding.expectedEpoch !== epoch ||
      !remoteAgentRuntimeEqual(binding.runtime, runtime)
    )
      throw new Error("Canonical setup admission did not preserve the prepared runtime epoch.");
    outcome = { value: epoch };
  } catch (cause) {
    outcome = { cause };
  } finally {
    signal.removeEventListener("abort", close);
    const cleanup = await Promise.allSettled(
      [...connections].map((connection) => connection.closeConfirmed()),
    );
    cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      [...cleanupFailures, ...(outcome && "cause" in outcome ? [outcome.cause] : [])],
      "Account setup proxy cleanup is unconfirmed; preserve state for repair.",
    );
  if (!outcome) throw new Error("Account setup admission did not settle an outcome.");
  if ("cause" in outcome) throw outcome.cause;
  return outcome.value;
}
export const localSupervisorServiceSetupDependencies: LocalSupervisorServiceSetupDependencies =
  Object.freeze<LocalSupervisorServiceSetupDependencies>({
    account: () => {
      const actual = userInfo();
      return {
        home: actual.homedir,
        uid: actual.uid,
        operatingSystem: platform(),
        architecture: arch(),
      };
    },
    control: (home, target, signal) =>
      scopeLocalSupervisorControl(
        makeLocalSupervisorControl({ homeDir: home, targetId: target }),
        signal,
      ),
    claim: claimLocalSupervisorAuthorityReservation,
    install,
    admit,
  });
