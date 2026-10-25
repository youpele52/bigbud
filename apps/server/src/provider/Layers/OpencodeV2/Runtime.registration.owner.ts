import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { consumeV2RuntimeEvent } from "./Runtime.stream.ts";
import { noteV2ChildHint } from "./Runtime.subagents.ts";

/** Root deliveries retain their original owner, dirty generation and abort fence. */
export function registerV2RuntimeOwner(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  serialize: (run: () => Promise<void>) => Promise<void>,
) {
  return owner.lease.hub.register({
    nativeSessionId: owner.native.id,
    location: owner.native.location.directory,
    onEvent: (event, signal) => {
      const epoch = owner.epoch,
        dirty = owner.dirtyGeneration;
      const generation = owner.lease.hub.generation(owner.native.id);
      const validate = () => {
        signal.throwIfAborted();
        owner.consentPermit?.assertCurrent();
        if (
          runtime.sessions.get(owner.threadId) !== owner ||
          owner.stopped ||
          owner.epoch !== epoch ||
          owner.dirtyGeneration !== dirty ||
          owner.lease.hub.generation(owner.native.id) !== generation
        )
          throw new Error("V2 stale stream delivery rejected.");
      };
      return serialize(() => consumeV2RuntimeEvent(runtime, owner, event, validate));
    },
    onDirty: () => runtime.scheduleRepair(owner),
    onDrained: () => runtime.scheduleRepair(owner, false),
    onChildHint: () => noteV2ChildHint(runtime, owner),
  });
}
