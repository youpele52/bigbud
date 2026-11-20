import * as Data from "effect/Data";
import { RemoteBackendSetupRefusalReason } from "@bigbud/contracts/server/remoteBackendDeployment.ts";
import type {
  RemoteAgentRegistry,
  RemoteAgentRegistryBuild,
} from "../remote-agent/remoteAgentInstall.registry.ts";

/** Typed reasons `backend setup` refuses to adopt existing managed remote-agent state. */
export const SETUP_ADOPTION_REFUSAL_CODES = RemoteBackendSetupRefusalReason.literals;
export type SetupAdoptionRefusalCode = (typeof SETUP_ADOPTION_REFUSAL_CODES)[number];

export class LocalSupervisorSetupAdoptionRefusal extends Data.TaggedError(
  "LocalSupervisorSetupAdoptionRefusal",
)<{
  readonly code: SetupAdoptionRefusalCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const refuseAdoption = (
  code: SetupAdoptionRefusalCode,
  message: string,
  cause?: unknown,
): never => {
  throw new LocalSupervisorSetupAdoptionRefusal({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
};

/** Top-level names a managed (P4/D5) remote-agent install creates under `~/.bigbud/agent`. */
export const ADOPTABLE_AGENT_ENTRIES: ReadonlySet<string> = new Set([
  "account-authority-v1",
  "control-v1",
  "bin",
  "runtimes",
  "staging",
  "inbox",
]);
/** Legacy unmanaged supervisor state; only explicit migration may take it over. */
export const LEGACY_AGENT_ENTRIES: ReadonlySet<string> = new Set(["state"]);

const IN_FLIGHT_UPDATES = new Set(["waiting-for-capacity", "reserved", "installing", "checking"]);
const SETTLED_RETIREMENTS = new Set(["tombstoned", "failed"]);
const SETTLED_RESTARTS = new Set(["ready", "failed"]);

export interface AdoptableRegistryAssessment {
  readonly presentBuilds: ReadonlyArray<RemoteAgentRegistryBuild>;
  /** Connection IDs other controllers pinned; adoption never releases them. */
  readonly connectionIds: ReadonlySet<string>;
}

/** Pure registry rules. Anything in flight, uncertain, legacy or unauthenticated is refused. */
export function assessAdoptableRegistry(state: RemoteAgentRegistry): AdoptableRegistryAssessment {
  if (state.schemaVersion === 3)
    refuseAdoption(
      "foreign-owner",
      "Mobile components on this account belong to another backend; remove that backend first.",
    );
  if (
    state.pins.some((pin) => pin.owner === "unknown-legacy-owner") ||
    state.builds.some((build) => build.runtime.origin !== "managed")
  )
    refuseAdoption(
      "legacy-owner",
      "This account runs a legacy or externally placed agent. Update it to a managed build from bigbud on your laptop, then retry.",
    );
  if (
    state.pending !== null ||
    state.stages.some((stage) => stage.phase === "reserved") ||
    state.slotReservations.some((slot) => slot.phase === "reserved") ||
    state.updates.some((update) => IN_FLIGHT_UPDATES.has(update.phase)) ||
    state.retirementReservations.some((entry) => !SETTLED_RETIREMENTS.has(entry.phase)) ||
    state.restartReservations.some((entry) => !SETTLED_RESTARTS.has(entry.phase)) ||
    state.admissions.some((admission) => admission.phase === "prepared") ||
    state.launches.some((launch) => launch.phase === "reserved") ||
    state.builds.some((build) => build.binary === "deleting")
  )
    refuseAdoption(
      "install-in-progress",
      "A remote-agent install, update or retirement is in progress on this account. Let it finish in bigbud on your laptop, then retry.",
    );
  if (
    state.updates.some((update) => update.phase === "uncertain") ||
    state.stages.some((stage) => stage.failure === "ambiguous") ||
    state.launches.some((launch) => launch.phase === "spawn-uncertain")
  )
    refuseAdoption(
      "ambiguous-state",
      "A previous remote-agent operation has an uncertain outcome. Reconnect from bigbud on your laptop so it settles, then retry.",
    );
  const presentBuilds = state.builds.filter((build) => build.binary === "present");
  const present = new Set(presentBuilds.map((build) => build.id));
  if (
    state.pins.some((pin) => !present.has(pin.buildId)) ||
    [state.current, state.predecessor].some((id) => id !== null && !present.has(id))
  )
    refuseAdoption(
      "ambiguous-state",
      "The agent registry references builds whose files are missing; repair it from bigbud on your laptop first.",
    );
  if (presentBuilds.some((build) => !build.authenticated))
    refuseAdoption(
      "unverifiable-build",
      "An installed agent build was never signature-verified; reinstall a signed build from bigbud, then retry.",
    );
  return {
    presentBuilds,
    connectionIds: new Set(
      state.pins
        .filter((pin) => pin.owner.startsWith("connection:"))
        .map((pin) => pin.owner.slice("connection:".length)),
    ),
  };
}

/** Installing a new candidate beside two distinct installed builds needs retirement setup cannot do. */
export function assertAdoptionCapacity(
  presentBuilds: ReadonlyArray<RemoteAgentRegistryBuild>,
  candidateBuildIds: ReadonlySet<string>,
): void {
  if (presentBuilds.some((build) => candidateBuildIds.has(build.id))) return;
  if (new Set(presentBuilds.map((build) => build.runtime.sha256)).size >= 2)
    refuseAdoption(
      "no-capacity",
      "Two other agent builds already occupy this account. Retire the unused one from bigbud on your laptop (Update/Replace), then retry.",
    );
}

/** Stable stderr line `backend setup` prints so the laptop deployment can map the reason. */
export const formatSetupRefusalLine = (refusal: LocalSupervisorSetupAdoptionRefusal) =>
  `bigbud backend: Setup refused (${refusal.code}): ${refusal.message}\n`;
export function parseSetupRefusalCode(stderr: string): SetupAdoptionRefusalCode | undefined {
  const code = /^bigbud backend: Setup refused \(([a-z-]{1,32})\):/m.exec(stderr)?.[1];
  return SETUP_ADOPTION_REFUSAL_CODES.find((known) => known === code);
}

/** Walk a bounded cause chain (Effect failures, setup/preflight wrappers) for a refusal. */
export function findSetupAdoptionRefusal(
  value: unknown,
): LocalSupervisorSetupAdoptionRefusal | undefined {
  let current = value;
  for (let depth = 0; depth < 16 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof LocalSupervisorSetupAdoptionRefusal) return current;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}
