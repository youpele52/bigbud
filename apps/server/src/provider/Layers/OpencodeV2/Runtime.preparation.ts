import type { V2IsolatedRuntimeOptions, V2StartInput, V2RuntimeSession } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { createRuntimeSession } from "./Runtime.sessions.ts";

/** Target resources belong to this startup attempt; partial acquisition never escapes cleanup. */
export async function prepareV2RuntimeSession(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  mutations: V2RuntimeMutations,
  signal: AbortSignal,
  disableTools: boolean,
) {
  const prepared = await options.prepareSession?.(input, signal, disableTools);
  try {
    const created = await createRuntimeSession(
      prepared?.options ?? options,
      prepared?.input ?? input,
      mutations,
      signal,
      disableTools,
    );
    return { ...created, ...(prepared ? { resources: prepared.resources } : {}) };
  } catch (error) {
    await prepared?.resources.cleanup();
    throw error;
  }
}

/** Local target resources and the native lease settle independently, even when either fails. */
export async function releaseV2PreparedSession(
  session: Pick<V2RuntimeSession, "resources" | "lease">,
) {
  try {
    await session.resources?.cleanup();
  } finally {
    await session.lease.release();
  }
}
