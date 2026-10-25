import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { realpath } from "node:fs/promises";
import { listenOwnershipControl, ownershipIdentity } from "@bigbud/shared/backendOwnership.control";
import type { StateDirLockHandle } from "./stateDirLock";
import { createSupervisorPreparation } from "./ownershipHandoff.supervisor.ts";

/** Only reads descriptors explicitly announced by the matching desktop bootstrap envelope. */
export async function createOwnershipHandoff(
  stateDir: string,
  shutdown: () => void,
  pipes?: { readonly input: Readable; readonly output: Writable },
) {
  const input = pipes?.input ?? new Socket({ fd: 7, readable: true, writable: false });
  let output: Writable;
  try {
    output = pipes?.output ?? new Socket({ fd: 6, readable: false, writable: true });
  } catch (error) {
    input.destroy();
    throw error;
  }
  let handle: StateDirLockHandle | undefined;
  let canonical = "";
  const supervisor = createSupervisorPreparation(input, output);
  let committed = false;
  const assertHeld = async () => {
    if (!handle) throw new Error("owner_unverified");
    const { readOwnershipLock } = await import("@bigbud/shared/backendOwnership.record");
    const current = await readOwnershipLock(handle.lockPath);
    if (
      !current ||
      ownershipIdentity(current, canonical) !== ownershipIdentity(handle.record, canonical)
    )
      throw new Error("owner_changed");
  };
  const endpoint = await listenOwnershipControl(async (request) => {
    await assertHeld();
    if (!handle || request.identity !== ownershipIdentity(handle.record, canonical))
      return "owner_changed";
    if (request.action === "inspect") return "available";
    // Authenticated requesters of this exact acquisition may finish an abandoned handoff.
    // Operation ids are correlation ids, not an exclusive lease over supervisor quiescence.
    if (request.action === "status")
      return committed ? "committed" : supervisor.isQuiesced() ? "prepared" : "available";
    if (request.action === "prepare") {
      const prepared = await supervisor.prepare(request.identity);
      await assertHeld();
      return prepared ? "prepared" : "supervisor_unavailable";
    }
    if (!supervisor.isQuiesced()) return "supervisor_unavailable";
    await assertHeld();
    if (!committed) {
      committed = true;
      // Let the bounded acceptance response flush before closing the application scope.
      setImmediate(shutdown);
    }
    return "committed";
  }).catch((error: unknown) => {
    supervisor.close();
    throw error;
  });
  return {
    control: endpoint.control,
    attach: async (owner: StateDirLockHandle) => {
      canonical = await realpath(stateDir);
      handle = owner;
    },
    close: async () => {
      supervisor.close();
      await endpoint.close();
    },
  };
}
