import type { RemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import type { RemoteAgentInstallControlOp } from "./remoteAgentControl.ops.install.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/**
 * U25 template specs: one per owner `agent_control` kind (and variant). Sentinel
 * operands are chosen to pass every legacy builder's validation and to appear
 * nowhere else in any script.
 */
const ROOT = "/bbsentroot/.bigbud/agent";
const SHA = "5e17".repeat(16);
const b64 = (text: string) => Buffer.from(text).toString("base64");

const values = {
  root: ROOT,
  generation: "bbsentgen",
  version: "bbsentver",
  sha256: SHA,
  binary: `${ROOT}/bin/bbsentver/${SHA}/bigbud-remote-agent`,
  state: `${ROOT}/runtimes/bbsentgen`,
  socket: `${ROOT}/runtimes/bbsentgen/supervisor.sock`,
  log: `${ROOT}/runtimes/bbsentgen/supervisor.log`,
  attempt: "bbsentattempt",
  old_attempt: "bbsentoldattempt",
  epoch: "bbsentepoch",
  old_epoch: "bbsentoldepoch",
  reservation: "bbsentreservation",
  fence: "bbsentfence",
  size: "987654321",
  binary_path: "/bbsentexternal/bigbud-remote-agent",
} as const;
type Name = keyof typeof values;

export const SENTINEL = {
  values,
  /** Validated as `[A-Za-z0-9._+-]` or hex, so an unquoted expansion is one safe word. */
  bare: [
    "generation",
    "version",
    "sha256",
    "attempt",
    "reservation",
    "size",
  ] as ReadonlyArray<Name>,
  markers: ["bbsent", SHA, values.size, b64("bbsentexpected"), b64("bbsentnext")],
} as const;

const runtime: RemoteAgentRuntime = {
  generation: values.generation,
  version: values.version,
  sha256: SHA,
  buildDigest: "bbsentdigest",
  targetTriple: "aarch64-unknown-linux-gnu",
  binaryPath: values.binary,
  statePath: values.state,
  socketPath: values.socket,
  logPath: values.log,
  origin: "managed",
};
const artifact = {
  version: values.version,
  sha256: SHA,
  sizeBytes: Number(values.size),
  targetTriple: "aarch64-unknown-linux-gnu" as const,
};

export interface AgentControlTemplateSpec {
  /** File under `owner_agent_control/templates/`. */
  readonly file: string;
  /** Legacy builder, for the generated header. */
  readonly source: string;
  readonly op: RemoteAgentControlOp | RemoteAgentInstallControlOp;
  /** The first ten positional operands are the runtime descriptor. */
  readonly runtime: boolean;
  /** Further positional operands, in order. */
  readonly operands: ReadonlyArray<string>;
  /** Sentinels this template may bind. */
  readonly allowed: ReadonlyArray<Name>;
  readonly transforms?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

const RUNTIME_NAMES: ReadonlyArray<Name> = [
  "root",
  "generation",
  "version",
  "sha256",
  "binary",
  "state",
  "socket",
  "log",
];

const streamed = (target: string, size: string, sha: string, read: string) =>
  `${read} > "$${target}"
test "$(wc -c < "$${target}")" -eq "$bigbud_arg_${size}" || exit 65
test "$(sha256sum < "$${target}" | cut -d ' ' -f1)" = "$bigbud_arg_${sha}" || exit 65`;

const nextRead = {
  from: `printf '%s' '${b64("bbsentnext")}' | base64 --decode > "$next"`,
  to: streamed("next", "next_size", "next_sha256", "cat"),
};

const plain = (file: string, source: string, op: AgentControlTemplateSpec["op"]) =>
  ({ file, source, op, runtime: false, operands: [], allowed: ["root"] }) as const;

const withRuntime = (
  file: string,
  source: string,
  op: AgentControlTemplateSpec["op"],
  operands: ReadonlyArray<Name> = [],
): AgentControlTemplateSpec => ({
  file,
  source,
  op,
  runtime: true,
  operands,
  allowed: [...RUNTIME_NAMES, ...operands],
});

const OBSERVE_MODES = [
  "retirementState",
  "retirementExit",
  "launchExit",
  "raw",
  "candidateStartup",
  "candidateExit",
  "replacementReadiness",
  "replacementDeath",
] as const;

export const AGENT_CONTROL_TEMPLATE_SPECS: ReadonlyArray<AgentControlTemplateSpec> = [
  plain("control_root.sh", "openRemoteAgentControl", { kind: "controlRoot" }),
  plain("registry_read.sh", "buildRemoteAgentRegistryRead", { kind: "registryRead" }),
  {
    file: "registry_cas.absent.sh",
    source: "buildRemoteAgentRegistryCas",
    op: { kind: "registryCas", expected: null, next: "bbsentnext" },
    runtime: false,
    operands: ["next_size", "next_sha256"],
    allowed: ["root"],
    transforms: [nextRead],
  },
  {
    file: "registry_cas.present.sh",
    source: "buildRemoteAgentRegistryCas",
    op: { kind: "registryCas", expected: "bbsentexpected", next: "bbsentnext" },
    runtime: false,
    operands: ["expected_size", "expected_sha256", "next_size", "next_sha256"],
    allowed: ["root"],
    transforms: [
      {
        from: `printf '%s' '${b64("bbsentexpected")}' | base64 --decode > "$expected"`,
        to: streamed(
          "expected",
          "expected_size",
          "expected_sha256",
          'head -c "$bigbud_arg_expected_size"',
        ),
      },
      nextRead,
    ],
  },
  {
    ...plain("stage_fence_revoke.sh", "buildRemoteAgentStageFenceRevokeCommand", {
      kind: "stageFenceRevoke",
      reservationId: values.reservation,
    }),
    operands: ["reservation"],
    allowed: ["root", "reservation"],
  },
  plain("inventory.sh", "buildRemoteAgentInventoryCommand", { kind: "inventory" }),
  ...OBSERVE_MODES.map((mode) =>
    withRuntime(
      `supervisor_observe.${mode}.sh`,
      `supervisor observation (${mode})`,
      { kind: "supervisorObserve", mode, runtime, attemptId: values.attempt },
      ["attempt"],
    ),
  ),
  withRuntime(
    "admission_death_observe.sh",
    "buildRemoteAgentAdmissionDeathObservation",
    { kind: "admissionDeathObserve", runtime, attemptId: values.attempt, epoch: values.epoch },
    ["attempt", "epoch"],
  ),
  withRuntime("state_absent.sh", "buildRemoteAgentStateAbsentProbe", {
    kind: "stateAbsent",
    runtime,
  }),
  withRuntime("supervisor_shutdown.sh", "buildRemoteAgentSupervisorShutdownCommand", {
    kind: "supervisorShutdown",
    runtime,
  }),
  withRuntime("supervisor_restart.sh", "buildRemoteAgentSupervisorRestartCommand", {
    kind: "supervisorRestart",
    runtime,
  }),
  withRuntime(
    "isolated_launch.sh",
    "buildIsolatedRemoteAgentLaunch",
    { kind: "isolatedLaunch", runtime, attemptId: values.attempt },
    ["attempt"],
  ),
  withRuntime(
    "replacement_launch.sh",
    "buildManagedRemoteAgentReplacementLaunch",
    {
      kind: "replacementLaunch",
      runtime,
      attemptId: values.attempt,
      oldEpoch: values.old_epoch,
      oldAttemptId: values.old_attempt,
    },
    ["attempt", "old_epoch", "old_attempt"],
  ),
  withRuntime("retirement_delete.sh", "buildRemoteAgentRetirementDeletionCommand", {
    kind: "retirementDelete",
    runtime,
  }),
  {
    ...plain("removal.sh", "buildRemoteAgentRemovalCommand (remove)", {
      kind: "removal",
      fenceId: values.fence,
    }),
    operands: ["fence"],
    allowed: ["root", "fence"],
  },
  plain("removal_resume.sh", "buildRemoteAgentRemovalCommand (resume)", { kind: "removalResume" }),
  plain("removal_outcome.sh", "buildRemoteAgentRemovalOutcomeProbe", { kind: "removalOutcome" }),
  plain("host_clock.sh", "readRemoteAgentHostClock", { kind: "hostClock" }),
  {
    ...plain("orphan_delete.sh", "buildRemoteAgentOrphanDeletionCommand", {
      kind: "orphanDelete",
      version: values.version,
      digest: SHA,
    }),
    operands: ["version", "sha256"],
    allowed: ["root", "version", "sha256", "binary"],
  },
  plain("backend_runtime_probe.sh", "REMOTE_AGENT_BACKEND_RUNTIME_PROBE", {
    kind: "backendRuntimeProbe",
  }),
  withRuntime("socket_live.sh", "buildRemoteAgentSocketLiveProbe", { kind: "socketLive", runtime }),
  withRuntime("socket_gone.sh", "buildRemoteAgentSocketGoneWait", { kind: "socketGone", runtime }),
  plain("runtime_probe.default.sh", "buildRemoteAgentRuntimeProbeCommand (bin/current)", {
    kind: "runtimeProbe",
    binaryPath: null,
  }),
  {
    ...plain("runtime_probe.external.sh", "buildRemoteAgentRuntimeProbeCommand (external)", {
      kind: "runtimeProbe",
      binaryPath: values.binary_path,
    }),
    operands: ["binary_path"],
    allowed: ["root", "binary_path"],
  },
  plain("platform_probe.sh", "buildRemoteAgentPlatformProbeScript", { kind: "platformProbe" }),
  plain("read_only_status.sh", "buildRemoteAgentRegistryReadOnlyProbe", {
    kind: "readOnlyStatus",
  }),
  ...([null, values.reservation] as const).map(
    (reservationId): AgentControlTemplateSpec => ({
      file: `install_upload.${reservationId ? "reserved" : "unreserved"}.sh`,
      source: "buildRemoteAgentInstallScript",
      op: { kind: "installUpload", artifact, reservationId, bytes: new Uint8Array([1]) },
      runtime: false,
      operands: ["version", "sha256", "size", ...(reservationId ? ["reservation"] : [])],
      allowed: ["root", "version", "sha256", "size", "reservation"],
      transforms: [{ from: 'base64 --decode > "$staged"', to: 'cat > "$staged"' }],
    }),
  ),
  {
    ...plain("placed_probe.sh", "buildRemoteAgentPlacedProbeScript", {
      kind: "placedProbe",
      artifact,
    }),
    operands: ["version", "sha256", "size"],
    allowed: ["root", "version", "sha256", "size"],
  },
  ...([null, values.reservation] as const).map(
    (reservationId): AgentControlTemplateSpec => ({
      file: `inbox_adopt.${reservationId ? "reserved" : "unreserved"}.sh`,
      source: "buildRemoteAgentInboxAdoptionScript",
      op: { kind: "inboxAdopt", artifact, reservationId },
      runtime: false,
      operands: ["version", "sha256", "size", ...(reservationId ? ["reservation"] : [])],
      allowed: ["root", "version", "sha256", "size", "reservation"],
    }),
  ),
  {
    ...plain("identity_check.sh", "buildRemoteAgentIdentityProbeCommand", {
      kind: "identityCheck",
      artifact,
    }),
    operands: ["version", "sha256"],
    allowed: ["root", "version", "sha256"],
  },
  plain("identity_check.default.sh", "buildRemoteAgentIdentityProbeCommand (bin/current)", {
    kind: "binaryCheck",
    binaryPath: null,
  }),
  {
    ...plain("identity_check.path.sh", "buildRemoteAgentIdentityProbeCommand (configured)", {
      kind: "binaryCheck",
      binaryPath: values.binary_path,
    }),
    operands: ["binary_path"],
    allowed: ["root", "binary_path"],
  },
];
