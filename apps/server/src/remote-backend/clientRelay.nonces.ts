import { RemoteBackendRelayError } from "@bigbud/contracts/server/remoteBackendRelay.ts";

interface RecordValue<A> {
  readonly callerId: string;
  readonly profileId: string | undefined;
  cancelled: boolean;
  value: A | undefined;
}
const key = (caller: string, nonce: string) => JSON.stringify([caller, nonce]);

/** Bounded caller-lifetime replay fences. Never evict cancelled/uncertain nonces to permit reuse. */
export function makeRelayOperationNonces<A>(maxCallerHistory = 128, maxHistory = 4096) {
  if (
    !Number.isInteger(maxCallerHistory) ||
    maxCallerHistory < 1 ||
    maxCallerHistory > 128 ||
    !Number.isInteger(maxHistory) ||
    maxHistory < maxCallerHistory ||
    maxHistory > 4096
  )
    throw new Error("Invalid bounded relay operation history.");
  const records = new Map<string, RecordValue<A>>(),
    counts = new Map<string, number>();
  const reserve = (caller: string, nonce: string, profileId: string | undefined) => {
    if (records.size >= maxHistory || (counts.get(caller) ?? 0) >= maxCallerHistory)
      throw new RemoteBackendRelayError({
        code: "limit",
        message:
          "Relay request history is full; reconnect the local client before opening another relay.",
      });
    const record: RecordValue<A> = {
      callerId: caller,
      profileId,
      cancelled: false,
      value: undefined,
    };
    records.set(key(caller, nonce), record);
    counts.set(caller, (counts.get(caller) ?? 0) + 1);
    return record;
  };
  return {
    get: (caller: string, nonce: string) => records.get(key(caller, nonce)),
    reserve,
    cancel: (caller: string, nonce: string) => {
      const record = records.get(key(caller, nonce)) ?? reserve(caller, nonce, undefined);
      record.cancelled = true;
      return record;
    },
    cancelCaller: (caller: string) => {
      for (const record of records.values())
        if (record.callerId === caller) record.cancelled = true;
    },
    forgetCaller: (caller: string) => {
      for (const [key, record] of records) if (record.callerId === caller) records.delete(key);
      counts.delete(caller);
    },
    clear: () => {
      records.clear();
      counts.clear();
    },
  };
}
