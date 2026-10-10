import { Service } from "@opencode/client/service";
import { makeV2Client } from "./Client.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
  v2SharedGeneration,
} from "./SharedService.registration.ts";
import { resolveV2SharedStorage, type V2SharedStorage } from "./SharedService.storage.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";

/** Borrow only a verified storage/generation. Closing releases our client, never the daemon. */
export async function borrowV2SharedService(expected: V2SharedStorage): Promise<OwnedV2Process> {
  const actual = await resolveV2SharedStorage(expected.registrationFile);
  if (
    actual.storageIdentity !== expected.storageIdentity ||
    actual.generation !== expected.generation
  )
    throw new Error(
      "V2 shared storage/service changed; restart bigbud to reconnect without rebinding history.",
    );
  const registration = await readV2SharedRegistration(expected.registrationFile);
  if (v2SharedGeneration(registration) !== actual.generation)
    throw new Error(
      "V2 shared registration changed after storage verification; no connection was borrowed.",
    );
  let closed = false,
    unavailable = false;
  const listeners = new Set<() => void>();
  const validate = async () => {
    if (closed || unavailable) throw new Error("V2 shared connection is detached.");
    if (
      !sameV2SharedRegistration(
        registration,
        await readV2SharedRegistration(expected.registrationFile),
      )
    ) {
      unavailable = true;
      for (const listener of listeners) listener();
      throw new Error("V2 shared service generation changed; no automatic resend.");
    }
  };
  return {
    ownership: "borrowed",
    client: makeV2Client({
      endpoint: registration.endpoint.url,
      headers: Service.headers(registration.endpoint),
      beforeRequest: validate,
    }),
    isRunning: () => !closed && !unavailable,
    hasExited: () => false, // Subscription disposal/health loss is never physical exit proof.
    onDeath: () => () => {},
    onUnavailable: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {
      closed = true;
      listeners.clear();
    },
  };
}
