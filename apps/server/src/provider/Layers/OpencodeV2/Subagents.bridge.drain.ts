import type { V2RuntimeSession } from "./Runtime.types.ts";
import { decodeV2NativeFamilyState } from "./Subagents.state.ts";

export interface V2FamilyPhysicalDrain {
  readonly invalidate: () => void;
  readonly confirmed: () => boolean;
}

/** Only a stopped native barrier proves physical retirement; an idle inspection
 * cannot fence shell creation after its snapshot. Every attachment starts unknown. */
export function makeV2NativeFamilyDrain(owner: V2RuntimeSession) {
  let revision = 0;
  let proof: string | undefined;
  let cached: { identity: string; revision: number; operation: Promise<void> } | undefined;
  const identity = () =>
    JSON.stringify([
      owner.storageIdentity,
      owner.native.id,
      owner.epoch,
      owner.lease.generation,
      owner.family?.generation,
      owner.family?.admission,
    ]);
  const authority: V2FamilyPhysicalDrain = Object.freeze({
    invalidate: () => {
      revision++;
      proof = undefined;
      cached = undefined;
    },
    confirmed: () => proof === identity() && Boolean(owner.family?.isFenced),
  });
  return {
    authority,
    fence: (
      call: () => Promise<unknown>,
      nonce: string,
      issuer: string,
      extension: boolean,
    ): Promise<void> => {
      const key = identity();
      const version = revision;
      if (cached?.identity === key && cached.revision === version) return cached.operation;
      const validate = () => {
        if (identity() !== key || revision !== version)
          throw new Error("V2 native drain proof changed input/generation; ownership retained.");
      };
      const operation = (async () => {
        await owner.family!.fence();
        validate();
        const state = decodeV2NativeFamilyState(await call(), owner, nonce);
        validate();
        if (
          !state.fenced ||
          !state.stopped ||
          state.inputId !== (owner.family!.admission?.id ?? null)
        )
          throw new Error("V2 native Stop fence is unconfirmed.");
        if (!extension) return; // Stock acknowledgement is not detached-shell proof.
        const evidence = state.nativeFamily;
        if (
          !evidence ||
          evidence.rootID !== owner.native.id ||
          evidence.ownerID !== issuer ||
          evidence.generation !== owner.family!.generation ||
          !evidence.stopped ||
          !evidence.settled ||
          evidence.uncertain ||
          evidence.pending
        )
          throw new Error("V2 native family cancel-and-drain is uncertain.");
        await owner.family!.confirmNativeDrain();
        validate();
        proof = key;
      })();
      cached = { identity: key, revision: version, operation };
      void operation.catch(() => {
        if (cached?.operation === operation) cached = undefined;
      });
      return operation;
    },
  };
}
