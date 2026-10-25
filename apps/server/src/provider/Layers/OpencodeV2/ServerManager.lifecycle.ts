import type { OwnedV2Process } from "./ServerManager.child.ts";

/** Startup rejected after dispatching native startup: retain its exact settlement observer and namespace. */
export class V2UnconfirmedProcessStartup extends Error {
  constructor(
    readonly process: OwnedV2Process,
    cause: unknown,
  ) {
    super("V2 protected SSH startup failed; native ownership remains unconfirmed.", { cause });
  }
}

/** Availability, bounded close, and transport exit are never substitutes for native physical exit. */
export function v2ProcessExited(process: OwnedV2Process): boolean {
  return process.hasExited?.() === true;
}
