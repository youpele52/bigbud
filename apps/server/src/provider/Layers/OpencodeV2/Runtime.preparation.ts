import type { V2IsolatedRuntimeOptions, V2StartInput, V2RuntimeSession } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { createRuntimeSession } from "./Runtime.sessions.ts";
import { settleV2PreparedReservation } from "./Runtime.activation.ts";

/** Target resources belong to this startup attempt; partial acquisition never escapes cleanup. */
export async function prepareV2RuntimeSession(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  mutations: V2RuntimeMutations,
  signal: AbortSignal,
  disableTools: boolean,
) {
  const prepared = await options.prepareSession?.(input, signal, disableTools);
  let created: Awaited<ReturnType<typeof createRuntimeSession>> | undefined;
  try {
    created = await createRuntimeSession(
      prepared?.options ?? options,
      prepared?.input ?? input,
      mutations,
      signal,
      disableTools,
    );
    const canonical = created.localTools
      ? await prepared?.resources.activateCanonicalTools?.()
      : undefined;
    return {
      ...created,
      ...(prepared ? { resources: { ...prepared.resources, ...canonical } } : {}),
    };
  } catch (error) {
    if (created) {
      let cleaned = false;
      try {
        await prepared?.resources.cleanup();
        cleaned = true;
      } finally {
        try {
          if (cleaned)
            await settleV2PreparedReservation(prepared?.options ?? options, created, mutations);
        } finally {
          await created.lease.release();
        }
      }
    } else await prepared?.resources.cleanup();
    throw error;
  }
}

/** Local target resources and the native lease settle independently, even when either fails. */
export async function releaseV2PreparedSession(
  session: Pick<V2RuntimeSession, "resources" | "lease">,
  shutdown?: AbortSignal,
) {
  try {
    try {
      await session.resources?.onThreadToolsCleanup?.(shutdown);
    } finally {
      await session.resources?.cleanup();
    }
  } finally {
    await session.lease.release();
  }
}
