import { randomUUID } from "node:crypto";
import type { ShellUnconfirmedLaunch } from "@bigbud/contracts/workspace/terminalShell.ts";
import {
  directShellLaunchDigest,
  directShellOwnerKey,
  parseDirectShellLaunchOwner,
  type DirectShellLaunchIntent,
  type DirectShellLaunchOwner,
  type DirectShellLaunchOwnerStore,
} from "./DirectShellLaunch.owner";
import { executionHostTerminalEnvironment } from "./ShellProfiles.remote.environment";
import { directShellProfileInvocation } from "./ShellProfiles.remote.launch";

export type DirectShellDispatchPlan = ReturnType<typeof directShellProfileInvocation>;
export type DirectShellDispatchRequest = {
  readonly threadId: string;
  readonly terminalId: string;
} & (
  | { readonly recoverOnly: true }
  | {
      readonly recoverOnly?: false;
      readonly intent: DirectShellLaunchIntent;
      readonly runtimeEnv?: NodeJS.ProcessEnv;
      readonly runtimeGeneration?: string;
    }
);
export type DirectShellDispatchResult =
  | { readonly action: "missing" }
  | {
      readonly action: "dispatched" | "retained";
      readonly owner: DirectShellLaunchOwner;
      readonly shellUnconfirmedLaunch: ShellUnconfirmedLaunch;
    };

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function retainedOwner(input: unknown, ownerKey: string): DirectShellLaunchOwner {
  const owner = parseDirectShellLaunchOwner(input);
  if (owner.ownerKey !== ownerKey) throw new Error("Direct shell owner pane identity conflict.");
  return freeze(owner);
}

function result(
  action: "dispatched" | "retained",
  owner: DirectShellLaunchOwner,
): DirectShellDispatchResult {
  return {
    action,
    owner,
    shellUnconfirmedLaunch: {
      status: "unconfirmed",
      requestedProfile: owner.intent.launch.requestedProfile,
    },
  };
}

/**
 * One-shot durable dispatch, not an execution-host recovery/exec-proof service.
 * Manager supplies lifecycle and pre-replacement ownership gating. No retries,
 * fallback, exit/EOF release, or dead-controller reclamation are permitted.
 */
export function makeDirectShellLaunchDispatcher(options: {
  readonly store: DirectShellLaunchOwnerStore;
  readonly transport: (plan: DirectShellDispatchPlan) => Promise<void>;
  readonly controllerId?: string;
}) {
  const { store, transport, controllerId = randomUUID() } = options;
  return async (input: DirectShellDispatchRequest): Promise<DirectShellDispatchResult> => {
    const ownerKey = directShellOwnerKey(input.threadId, input.terminalId);
    if (input.recoverOnly) {
      const saved = await store.get(ownerKey);
      return saved ? result("retained", retainedOwner(saved, ownerKey)) : { action: "missing" };
    }

    // Validate and detach all caller-owned data before the first asynchronous boundary.
    const candidate = retainedOwner(
      {
        version: 1,
        pane: { threadId: input.threadId, terminalId: input.terminalId },
        ownerKey,
        reservationId: randomUUID(),
        controllerId,
        intent: input.intent,
        digest: directShellLaunchDigest(input.intent),
        state: "prepared",
      },
      ownerKey,
    );
    // Current direct transport execs the shell itself. It cannot honor a host helper's
    // durable admission fence; accepting such intent here would make recovery unsafe.
    if (candidate.intent.lifecycle)
      throw new Error("Trusted direct shell lifecycle dispatch is not yet available.");
    const runtimeEnv = Object.fromEntries(
      executionHostTerminalEnvironment(input.runtimeEnv ?? {}).map(({ name, value }) => [
        name,
        value,
      ]),
    );
    const reserved = await store.reserve(candidate);
    const owner = retainedOwner(reserved.owner, ownerKey);
    // Even a same-digest prepared owner is not a dispatch permit for this request.
    if (!reserved.created) return result("retained", owner);
    if (
      owner.reservationId !== candidate.reservationId ||
      owner.controllerId !== candidate.controllerId ||
      owner.digest !== candidate.digest ||
      owner.state !== "prepared"
    )
      throw new Error("Direct shell reservation identity conflict.");

    // Only canonical stored intent supplies the invocation; no fresh inventory/defaults.
    const { intent } = owner;
    const launch = intent.launch;
    const requested = launch.requestedProfile;
    const plan = directShellProfileInvocation({
      executionTargetId: intent.executionTargetId,
      ...(intent.wslIdentity ? { wslIdentity: intent.wslIdentity } : {}),
      cwd: launch.cwd,
      launch: {
        shell: launch.executable,
        args: launch.args,
        platform: launch.platform,
        dropPathMode: "posix",
        identity: {
          ...requested,
          selection: { kind: "profile", profileId: requested.profileId },
          integration: { status: "disabled" },
        },
      },
      runtimeEnv,
      ...(input.runtimeGeneration ? { runtimeGeneration: input.runtimeGeneration } : {}),
    });
    // A thrown claim may have committed. Never cancel it, retry it, or dispatch.
    const claimed = await store.claimDispatch(ownerKey, owner.reservationId, owner.controllerId);
    if (!claimed) throw new Error("Direct shell dispatch claim was not granted.");
    const dispatched = freeze({ ...owner, state: "may-have-been-sent" as const });
    try {
      await transport(plan);
    } catch (error) {
      try {
        await store.markUnknown(ownerKey, owner.reservationId, owner.controllerId);
      } catch {
        // Ownership already fences redispatch; preserve the original transport failure.
      }
      throw error;
    }
    return result("dispatched", dispatched);
  };
}
