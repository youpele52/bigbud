import { vi } from "vitest";
import {
  directShellLaunchDigest,
  directShellOwnerKey,
  parseDirectShellLaunchOwner,
  type DirectShellLaunchIntent,
  type DirectShellLaunchOwner,
  type DirectShellLaunchOwnerStore,
} from "./DirectShellLaunch.owner";
import {
  makeDirectShellLaunchDispatcher,
  type DirectShellDispatchPlan,
} from "./DirectShellLaunch.dispatch";
import { shellProfileId } from "./ShellProfiles.identity";
import { remoteShellHost } from "./ShellProfiles.remote.identity";

export function intent(wsl = false): DirectShellLaunchIntent {
  const target = wsl
    ? {
        executionTargetId: "wsl:Ubuntu",
        wslIdentity: { distribution: "Ubuntu", username: "tester", uid: 1000 },
      }
    : { executionTargetId: "ssh:host=example.test&user=tester&port=2222&transport=direct-ssh" };
  const host = remoteShellHost(target);
  const executable = "/usr/bin/zsh";
  const args = ["-o", "nopromptsp", "argument with 'quotes'", ""];
  return {
    ...target,
    launch: {
      version: 1,
      cwd: "/srv/project with 'quotes'",
      requestedProfile: {
        host,
        profileId: shellProfileId(host, executable, args, "linux"),
        kind: "zsh",
      },
      executable,
      args,
      platform: "linux",
      integration: "disabled",
    },
  };
}

export const pane = { threadId: "thread", terminalId: "pane" };
export const ownerKey = directShellOwnerKey(pane.threadId, pane.terminalId);
export function request(wsl = false) {
  return { ...pane, intent: intent(wsl) };
}
export function prepared(state: DirectShellLaunchOwner["state"] = "prepared") {
  const launchIntent = intent();
  return parseDirectShellLaunchOwner({
    version: 1,
    ownerKey,
    reservationId: "old-reservation",
    controllerId: "dead-controller",
    intent: launchIntent,
    digest: directShellLaunchDigest(launchIntent),
    state,
  });
}

/** Atomic in-memory implementation of the durable store contract, for fault injection only. */
export function fixture() {
  const entries = new Map<string, DirectShellLaunchOwner>();
  const transition = (
    key: string,
    reservationId: string,
    controllerId: string,
    from: DirectShellLaunchOwner["state"],
    to: DirectShellLaunchOwner["state"],
  ) => {
    const owner = entries.get(key);
    if (
      !owner ||
      owner.reservationId !== reservationId ||
      owner.controllerId !== controllerId ||
      owner.state !== from
    )
      return false;
    entries.set(key, { ...owner, state: to });
    return true;
  };
  const store: DirectShellLaunchOwnerStore = {
    hasOwnersForThread: vi.fn(async (threadId) =>
      [...entries.values()].some((owner) => !owner.pane || owner.pane.threadId === threadId),
    ),
    get: vi.fn(async (key) => {
      const owner = entries.get(key);
      return owner && structuredClone(owner);
    }),
    reserve: vi.fn(async (input) => {
      const owner = parseDirectShellLaunchOwner(input);
      const existing = entries.get(owner.ownerKey);
      if (existing) return { created: false, owner: structuredClone(existing) };
      entries.set(owner.ownerKey, owner);
      return { created: true, owner: structuredClone(owner) };
    }),
    claimDispatch: vi.fn(async (key, reservationId, controllerId) =>
      transition(key, reservationId, controllerId, "prepared", "may-have-been-sent"),
    ),
    cancelPrepared: vi.fn(async () => {
      throw new Error("The controller must never cancel ownership.");
    }),
    markUnknown: vi.fn(async (key, reservationId, controllerId) =>
      transition(key, reservationId, controllerId, "may-have-been-sent", "outcome-unknown"),
    ),
  };
  const transport = vi.fn<(plan: DirectShellDispatchPlan) => Promise<void>>(async () => {});
  const controller = (controllerId = "controller") =>
    makeDirectShellLaunchDispatcher({ store, transport, controllerId });
  return { entries, store, transport, controller };
}

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
