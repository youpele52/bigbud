import { Effect, Option, Schema } from "effect";

import { isDevSshOwnerSelected } from "../../../ssh/sshOwnerDevMode.ts";
import type { DevSshOwnerRuntime } from "../../../ssh/sshOwnerDevRuntime.ts";
import type { PiRpcOwner, SelectedPiRpcOwner } from "./RpcProcess.owner.ts";

/** A dev owner that was selected but could not hand over its typed Pi port. */
export class SelectedPiOwnerError extends Schema.TaggedErrorClass<SelectedPiOwnerError>()(
  "SelectedPiOwnerError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** The started dev owner session, or `undefined` when the selected runtime is not composed. */
export type SelectedDevOwnerSession = NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>;

/** Structural read of the private provider port; retained and Windows owners do not expose it. */
function readPiRpcOwner(client: object): PiRpcOwner | undefined {
  const candidate = (client as { readonly piRpcOwner?: unknown }).piRpcOwner;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const port = candidate as Record<string, unknown>;
  return typeof port.probeProvider === "function" && typeof port.startProvider === "function"
    ? (candidate as PiRpcOwner)
    : undefined;
}

/**
 * Resolve the selected owner's typed Pi port for this dev runtime. The owner rechecks the exact
 * target, thread and epoch against its startup grant, so a non-matching session is a typed
 * refusal from the owner rather than a different launcher.
 */
export async function resolveSelectedPiRpcOwner(
  session: SelectedDevOwnerSession | undefined,
): Promise<SelectedPiRpcOwner | undefined> {
  if (!isDevSshOwnerSelected() || !session) return undefined;
  const { targetId } = session;
  const client = await session.picker.withOwner(targetId, async (owner) => owner as object);
  const owner = readPiRpcOwner(client);
  return owner ? { targetId, owner } : undefined;
}

/**
 * Effect-shaped entry point used by the Pi adapter composition. The dev runtime module is
 * imported lazily so an unselected or local-only graph never loads the owner fixture stack.
 */
export const selectedDevPiRpcOwner = Effect.fn("selectedDevPiRpcOwner")(function* () {
  if (!isDevSshOwnerSelected()) return undefined;
  const { DevSshOwnerRuntime: Runtime } = yield* Effect.promise(
    () => import("../../../ssh/sshOwnerDevRuntime.ts"),
  );
  const runtime = yield* Effect.serviceOption(Runtime);
  const session = Option.getOrUndefined(runtime)?.session;
  return yield* Effect.tryPromise({
    try: () => resolveSelectedPiRpcOwner(session),
    catch: (cause) =>
      new SelectedPiOwnerError({
        message: "Failed to reach the source-dev SSH owner for Pi.",
        cause,
      }),
  });
});
