import * as fs from "node:fs/promises";
import { join } from "node:path";
import { remoteAgentTargetArchitecture } from "@bigbud/shared/remoteAgentArtifact";
import { buildRemoteAgentIdentityProbeCommand } from "../remote-agent/remoteAgentConnection.identity.ts";
import { parseRemoteAgentCheckOutput } from "../remote-agent/remoteAgentIdentity.ts";
import {
  MAX_REMOTE_AGENT_REGISTRY_BYTES,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { remoteAgentArtifactBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { buildRemoteAgentSupervisorObservation } from "../remote-agent/remoteAgentSupervisorLiveness.ts";
import { assertLocalSupervisorBackendReservation } from "./localSupervisorAuthority.ts";
import type { LocalSupervisorAuthorityIdentity } from "./localSupervisorAuthority.record.ts";
import { verifyManagedLocalSupervisorArtifact } from "./localSupervisorBinary.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import {
  ADOPTABLE_AGENT_ENTRIES,
  LEGACY_AGENT_ENTRIES,
  assertAdoptionCapacity,
  assessAdoptableRegistry,
  refuseAdoption,
} from "./localSupervisorService.setup.adoption.rules.ts";

export interface SetupAgentAdoption {
  readonly mode: "adopt";
  /** Sorted top-level agent entries observed before the claim. */
  readonly names: ReadonlyArray<string>;
  readonly registryText: string;
  /** Candidate builds whose existing supervisor was observed ready; never relaunched or killed. */
  readonly liveBuildIds: ReadonlySet<string>;
  readonly connectionIds: ReadonlySet<string>;
}
export type SetupAgentState = { readonly mode: "fresh" } | SetupAgentAdoption;

const AUTHORITY = "account-authority-v1";
const PENDING = /^\.account-authority-[a-f0-9]{32}\.tmp$/;
const errno = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code;

async function listRoot(root: string): Promise<ReadonlyArray<string> | null> {
  try {
    return (await fs.readdir(root)).toSorted();
  } catch (cause) {
    if (errno(cause) === "ENOENT") return null;
    throw cause;
  }
}
const readRegistry = (root: string) =>
  readLocalSupervisorServiceFile(
    join(root, "control-v1/registry.json"),
    MAX_REMOTE_AGENT_REGISTRY_BYTES,
  );

/** Signed candidates setup may select for this graph's architecture. */
export function setupCandidateBuildIds(
  source: RemoteAgentInstallSource,
  graphTarget: string,
): ReadonlySet<string> {
  const architecture = graphTarget.split("-")[0];
  return new Set(
    source.manifest.artifacts
      .filter((artifact) => remoteAgentTargetArchitecture(artifact.targetTriple) === architecture)
      .map(remoteAgentArtifactBuildId),
  );
}

async function verifyInstalledBuild(
  control: LocalSupervisorControl,
  build: RemoteAgentRegistryBuild,
  signal: AbortSignal,
): Promise<void> {
  const { runtime } = build;
  try {
    await verifyManagedLocalSupervisorArtifact(runtime);
    const output = await control.run(
      control.targetId,
      buildRemoteAgentIdentityProbeCommand(runtime.binaryPath),
      { timeoutMs: 5000, maxBufferBytes: 4096, signal },
    );
    const identity = parseRemoteAgentCheckOutput(output.stdout);
    const architecture = runtime.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64";
    if (
      identity.version !== runtime.version ||
      identity.buildDigest !== runtime.buildDigest ||
      identity.operatingSystem !== "linux" ||
      identity.architecture !== architecture
    )
      throw new Error("Installed agent identity disagrees with its registry record.");
  } catch (cause) {
    signal.throwIfAborted();
    refuseAdoption(
      "unverifiable-build",
      `Installed agent build ${runtime.version} does not match its signed hash or identity. Reinstall it from bigbud on your laptop, then retry.`,
      cause,
    );
  }
}

/** A candidate either never ran (empty state) or has a supervisor observed ready right now. */
async function candidateIsLive(
  control: LocalSupervisorControl,
  state: RemoteAgentRegistry,
  build: RemoteAgentRegistryBuild,
  signal: AbortSignal,
): Promise<boolean> {
  const launch = state.launches.find((entry) => entry.buildId === build.id);
  if (!launch) {
    const entries = await fs.readdir(build.runtime.statePath).catch((cause: unknown) => {
      if (errno(cause) === "ENOENT") return [];
      throw cause;
    });
    if (entries.length)
      refuseAdoption(
        "ambiguous-state",
        "Runtime state exists for an agent build that has no launch record; repair it from bigbud on your laptop first.",
      );
    return false;
  }
  const observation = buildRemoteAgentSupervisorObservation(
    build.runtime,
    launch.attemptId ?? `launch-${build.runtime.generation}`,
  );
  const observed =
    launch.phase === "proven-dead"
      ? "proven-dead"
      : (
          await control.run(control.targetId, `${observation}\nobserve_supervisor`, {
            timeoutMs: 8000,
            maxBufferBytes: 256,
            signal,
          })
        ).stdout.trim();
  if (observed === "ready") return true;
  if (observed === "live")
    refuseAdoption(
      "install-in-progress",
      "The agent supervisor on this account is still starting; retry in a moment.",
    );
  if (
    observed === "proven-dead" ||
    observed === "prior-boot-dead" ||
    observed.startsWith("exited:")
  )
    refuseAdoption(
      "stale-supervisor",
      "The agent supervisor setup would reuse has stopped (for example after a reboot). Reconnect to this host from bigbud on your laptop once so it restarts, then retry.",
    );
  return refuseAdoption(
    "ambiguous-state",
    "The agent supervisor state could not be observed; preserve it and inspect it from bigbud on your laptop.",
  );
}

/** Read-only pre-claim gate: fresh, or fully verified adoptable managed state, or a typed refusal. */
export async function inspectSetupAgentState(input: {
  readonly control: LocalSupervisorControl;
  readonly identity: LocalSupervisorAuthorityIdentity;
  readonly backendStateDir: string;
  readonly candidateBuildIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<SetupAgentState> {
  const { control, signal } = input;
  const names = await listRoot(control.root);
  if (!names || names.every((name) => name === AUTHORITY)) return { mode: "fresh" };
  if (names.some((name) => PENDING.test(name)))
    refuseAdoption("ambiguous-state", "Another setup is claiming this account; retry later.");
  if (names.some((name) => LEGACY_AGENT_ENTRIES.has(name)))
    refuseAdoption(
      "legacy-owner",
      "This account has legacy unmanaged agent state in ~/.bigbud/agent/state; it needs explicit migration.",
    );
  const unknown = names.filter((name) => !ADOPTABLE_AGENT_ENTRIES.has(name));
  if (unknown.length)
    refuseAdoption(
      "unknown-state",
      `Unknown entries in ~/.bigbud/agent (${unknown.slice(0, 4).join(", ")}). Move them aside, then retry.`,
    );
  await assertLocalSupervisorServiceDirectory(control.root).catch((cause: unknown) =>
    refuseAdoption("unknown-state", "~/.bigbud/agent is not a private owned directory.", cause),
  );
  if (names.includes(AUTHORITY))
    await assertLocalSupervisorBackendReservation(
      control,
      input.identity,
      input.backendStateDir,
    ).catch((cause: unknown) =>
      refuseAdoption("foreign-owner", "Another backend already owns this account.", cause),
    );
  const registryText = await readRegistry(control.root).catch((cause: unknown) =>
    refuseAdoption(
      errno(cause) === "ENOENT" ? "unknown-state" : "unverifiable-registry",
      errno(cause) === "ENOENT"
        ? "Agent files exist without an agent registry; move ~/.bigbud/agent aside, then retry."
        : "The agent registry is unreadable or unsafe; preserve it and inspect it.",
      cause,
    ),
  );
  let state: RemoteAgentRegistry;
  try {
    state = parseRemoteAgentRegistry(registryText);
  } catch (cause) {
    return refuseAdoption("unverifiable-registry", "The agent registry is invalid.", cause);
  }
  const assessed = assessAdoptableRegistry(state);
  assertAdoptionCapacity(assessed.presentBuilds, input.candidateBuildIds);
  for (const build of assessed.presentBuilds) await verifyInstalledBuild(control, build, signal);
  const liveBuildIds = new Set<string>();
  for (const build of assessed.presentBuilds)
    if (
      input.candidateBuildIds.has(build.id) &&
      (await candidateIsLive(control, state, build, signal))
    )
      liveBuildIds.add(build.id);
  signal.throwIfAborted();
  return {
    mode: "adopt",
    names,
    registryText,
    liveBuildIds,
    connectionIds: assessed.connectionIds,
  };
}

/** Post-claim fence: the claimed root must still hold exactly the verified snapshot. */
export async function confirmSetupAgentState(
  control: LocalSupervisorControl,
  state: SetupAgentState,
): Promise<void> {
  const names = (await listRoot(control.root)) ?? [];
  if (state.mode === "fresh") {
    if (names.length !== 1 || names[0] !== AUTHORITY)
      throw new Error(
        "Fresh account setup refuses existing runtime or registry state; preserve it for explicit migration.",
      );
    return;
  }
  const expected = [...new Set([...state.names, AUTHORITY])].toSorted();
  const text = await readRegistry(control.root).catch(() => null);
  if (JSON.stringify(names) !== JSON.stringify(expected) || text !== state.registryText)
    refuseAdoption(
      "install-in-progress",
      "The agent state changed while setup took ownership; let the other operation finish, then retry.",
    );
}

/** Adoption never releases connection pins that other controllers recorded before it. */
export function preserveAdoptedConnections(
  owners: RemoteAgentOwnerStore,
  state: SetupAgentState,
): RemoteAgentOwnerStore {
  if (state.mode !== "adopt") return owners;
  const references = owners.hasDurableReferences;
  return {
    ...owners,
    hasDurableReferences: async (target, connectionId) =>
      state.connectionIds.has(connectionId) ||
      (references ? references(target, connectionId) : true),
  };
}
