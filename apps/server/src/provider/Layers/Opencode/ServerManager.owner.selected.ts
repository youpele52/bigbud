import { Effect, Option, Schema } from "effect";

import { isSshOwnerDevFixtureSelected } from "../../../ssh/sshOwnerSelection.ts";
import type { DevSshOwnerRuntime } from "../../../ssh/sshOwnerDevRuntime.ts";
import type { ProviderExecutionContext } from "../../providerExecutionContext.ts";
import type { OpencodeServerHandle } from "../../Services/Opencode/ServerManager.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  startOwnedOpencodeServer,
  type OpencodeSshOwner,
  type OwnedOpencodeServer,
} from "./ServerManager.owner.ts";

/** A dev owner that was selected but could not hand over its typed OpenCode v1 service. */
export class SelectedOpencodeOwnerError extends Schema.TaggedErrorClass<SelectedOpencodeOwnerError>()(
  "SelectedOpencodeOwnerError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** The started dev owner session, or `undefined` when the selected runtime is not composed. */
export type SelectedDevOwnerSession = NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>;

export interface SelectedOpencodeOwner {
  readonly targetId: string;
  readonly owner: OpencodeSshOwner;
}

/** A started owner lease presented through the existing managed-server handle interface. */
export interface StartedOpencodeOwnerServer {
  readonly handle: OpencodeServerHandle;
  /** Awaits the owner's confirmed listener and transport teardown. */
  readonly close: () => Promise<void>;
}

/**
 * Structural read of the private provider port; retained and Windows owners do not expose it and
 * therefore fall back to the typed "unavailable" refusal rather than legacy SSH.
 */
function readOpencodeOwner(client: object): OpencodeSshOwner | undefined {
  const candidate = (client as { readonly opencodeOwner?: unknown }).opencodeOwner;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const port = candidate as Record<string, unknown>;
  return typeof port.startProvider === "function" ? (candidate as OpencodeSshOwner) : undefined;
}

export async function resolveSelectedOpencodeOwner(
  session: SelectedDevOwnerSession | undefined,
): Promise<SelectedOpencodeOwner | undefined> {
  if (!isSshOwnerDevFixtureSelected() || !session) return undefined;
  const { targetId } = session;
  const client = await session.picker.withOwner(targetId, async (owner) => owner as object);
  const owner = readOpencodeOwner(client);
  return owner ? { targetId, owner } : undefined;
}

function present(server: OwnedOpencodeServer): StartedOpencodeOwnerServer {
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= server.close());
  return {
    close,
    handle: {
      client: server.client,
      url: server.url,
      release: () => void close().catch(() => undefined),
      invalidate: () => void close().catch(() => undefined),
      onInvalidated: (listener) => server.onUnexpectedDeath?.(listener) ?? (() => undefined),
    },
  };
}

/**
 * Selected dev composition for OpenCode v1. Returns `undefined` outside the selected remote
 * domain so local OpenCode and the unselected legacy path are untouched. The owner selects the
 * loopback-to-loopback listener; this module never builds a forwarding specification.
 */
export const startSelectedOpencodeOwnerServer = Effect.fn("startSelectedOpencodeOwnerServer")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sessionEpoch: number;
    readonly binaryPath: string;
    readonly executionContext: ProviderExecutionContext;
  }) {
    if (
      !isSshOwnerDevFixtureSelected() ||
      input.executionContext.providerRuntimeTarget.location === "local"
    ) {
      return undefined;
    }
    const { DevSshOwnerRuntime: Runtime } = yield* Effect.promise(
      () => import("../../../ssh/sshOwnerDevRuntime.ts"),
    );
    const runtime = yield* Effect.serviceOption(Runtime);
    const session = Option.getOrUndefined(runtime)?.session;
    const selected = yield* Effect.tryPromise({
      try: () => resolveSelectedOpencodeOwner(session),
      catch: (cause) =>
        new SelectedOpencodeOwnerError({
          message: "Failed to reach the source-dev SSH owner for OpenCode v1.",
          cause,
        }),
    });
    if (!selected) {
      return yield* new SelectedOpencodeOwnerError({
        message:
          "The selected source-dev SSH owner has no OpenCode v1 service bound. No legacy SSH was started.",
        cause: undefined,
      });
    }
    const server = yield* Effect.tryPromise({
      try: () =>
        startOwnedOpencodeServer({
          owner: selected.owner,
          threadId: input.threadId,
          sessionEpoch: input.sessionEpoch,
          providerRuntimeTarget: input.executionContext.providerRuntimeTarget,
          workspaceTarget: input.executionContext.workspaceTarget,
          binaryPath: input.binaryPath,
        }),
      catch: (cause) =>
        new SelectedOpencodeOwnerError({
          message: "Failed to start the source-dev SSH owner OpenCode v1 server.",
          cause,
        }),
    });
    return present(server);
  },
);
