import { V2SharedServiceError } from "./SharedService.errors.ts";
import { Service } from "@opencode/client/service";
import { makeV2Client } from "./Client.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
  v2SharedGeneration,
} from "./SharedService.registration.ts";
import { resolveV2SharedConnection, type V2SharedConnection } from "./SharedService.descriptor.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";

/** Borrow only a verified storage/generation. Closing releases our client, never the daemon. */
export async function borrowV2SharedService(expected: V2SharedConnection): Promise<OwnedV2Process> {
  const actual = await resolveV2SharedConnection(expected.registrationFile);
  if (actual.storageIdentity !== expected.storageIdentity)
    throw new V2SharedServiceError("storage", "V2 shared storage namespace changed; no rebinding.");
  if (actual.generation !== expected.generation)
    throw new V2SharedServiceError(
      "generation",
      "V2 shared service changed; restart bigbud to reconnect without rebinding history.",
    );
  const registration = await readV2SharedRegistration(expected.registrationFile);
  if (v2SharedGeneration(registration) !== actual.generation)
    throw new V2SharedServiceError(
      "generation",
      "V2 shared registration changed after storage verification; no connection was borrowed.",
    );
  let closed = false,
    unavailable = false;
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const detach = () => {
    if (unavailable) return;
    unavailable = true;
    controller.abort();
    for (const listener of listeners) listener();
  };
  const validate = async () => {
    if (closed || unavailable) throw new Error("V2 shared connection is detached.");
    try {
      const current = await readV2SharedRegistration(expected.registrationFile);
      if (closed || unavailable || !sameV2SharedRegistration(registration, current))
        throw new V2SharedServiceError(
          "generation",
          "V2 shared service generation changed; no automatic resend.",
        );
    } catch (error) {
      detach();
      throw error;
    }
  };
  const client = makeV2Client({
    endpoint: registration.endpoint.url,
    headers: Service.headers(registration.endpoint),
    beforeRequest: validate,
    afterResponse: validate,
    signal: controller.signal,
    sharedTransport: expected.registrationFile,
  });
  bindV2NativeCompatibility(client, {
    descriptor: actual,
    assertCurrent: () => {
      if (closed || unavailable) throw new Error("V2 shared connection is detached.");
    },
  });
  return {
    ownership: "borrowed",
    client,
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
      detach();
      listeners.clear();
    },
  };
}
