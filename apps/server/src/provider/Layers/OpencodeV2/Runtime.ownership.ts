import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";

/** Shared native session metadata must still designate this exact app owner before mutation. */
export async function assertV2SharedSessionOwner(
  owner: V2RuntimeSession,
  checkPolicy = true,
): Promise<void> {
  if (owner.lease.process.ownership !== "borrowed") return;
  const native = await v2Request("owned session.verify", (signal) =>
    owner.lease.process.client.session.get({ sessionID: owner.native.id }, { signal }),
  );
  if (
    native.id !== owner.native.id ||
    native.location.directory !== owner.native.location.directory ||
    native.metadata?.bigbud_provider !== "opencodeV2" ||
    native.metadata.bigbud_thread !== owner.threadId ||
    native.metadata.bigbud_storage !== owner.storageIdentity ||
    (checkPolicy && JSON.stringify(native.permissions) !== JSON.stringify(owner.toolPolicy))
  )
    throw new Error(
      "Shared V2 session ownership/access policy changed in OpenCode. Stop this binding before starting new work; no unrelated native session was mutated.",
    );
}
