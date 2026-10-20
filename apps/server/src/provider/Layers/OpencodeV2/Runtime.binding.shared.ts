import { Effect } from "effect";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import { v2RetainedRegistrationFamily } from "./Runtime.registration.ts";
import type { V2IsolatedRuntimeOptions, V2StartInput } from "./Runtime.types.ts";

/** Local durable evidence wins over newly derived IDs; conflicts never permit replacement. */
export async function retainedSharedIdentity(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  target: { directory: string; runtimeTarget: string; workspaceTarget: string },
) {
  if (!options.sharedBindings)
    throw new Error("V2 shared binding repository unavailable; no native dispatch.");
  const row = await Effect.runPromise(options.sharedBindings.find(input.threadId));
  const journal = await Effect.runPromise(options.journal.latestBound(input.threadId));
  const cursor = input.resumeCursor === undefined ? undefined : decodeV2Cursor(input.resumeCursor);
  if (cursor?.connectionMode === "isolated")
    throw new Error("V2 retired-isolated history is read-only; no shared replacement or replay.");
  if (
    (cursor || journal) &&
    !row &&
    (cursor?.connectionMode !== "shared" ||
      cursor.storageIdentity !== options.config.sharedService?.storageIdentity)
  )
    throw new Error(
      "V2 unsupported-retained-binding: shared native ownership cannot be proved; history remains read-only.",
    );
  const candidates = [
    ...(row ? [row] : []),
    ...(journal ? [{ ...journal.binding, directory: journal.binding.location }] : []),
    ...(cursor ? [cursor] : []),
  ];
  const first = candidates[0];
  const profileIssuer = await options.profileIssuer?.();
  const registrationFamily = v2RetainedRegistrationFamily(row, cursor, profileIssuer);
  for (const candidate of candidates) {
    if (
      candidate.nativeSessionId !== first?.nativeSessionId ||
      candidate.storageIdentity !== first?.storageIdentity ||
      candidate.directory !== target.directory ||
      ("runtimeTargetId" in candidate && candidate.runtimeTargetId !== target.runtimeTarget) ||
      ("workspaceTargetId" in candidate &&
        candidate.workspaceTargetId !== target.workspaceTarget) ||
      ("threadId" in candidate && candidate.threadId !== input.threadId)
    )
      throw new Error("V2 retained shared history conflicts; no replacement or replay.");
  }
  return first
    ? {
        nativeSessionId: first.nativeSessionId,
        storageIdentity: first.storageIdentity,
        registrationFamily,
      }
    : undefined;
}
