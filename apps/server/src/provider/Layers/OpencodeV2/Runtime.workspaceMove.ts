import { isDeepStrictEqual } from "node:util";
import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";
import { decodeV2NativeSession } from "./Runtime.session.decode.ts";

export type V2WorkspaceMoveClient = {
  readonly session: Pick<OpencodeV2Client["session"], "get" | "move" | "active" | "inbox">;
};

export interface V2WorkspaceMoveIntent {
  readonly nativeSessionId: string;
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  /** Set only from durable dispatched intent, never inferred from a native response. */
  readonly dispatched: boolean;
  readonly expectedIdentity?: {
    readonly created: number;
    readonly model: unknown;
    readonly metadata: unknown;
  };
}

/** Official native move only. The caller owns consent, durable intent, and workspace fencing. */
export async function moveV2NativeWorkspace(input: {
  readonly client: V2WorkspaceMoveClient;
  readonly intent: V2WorkspaceMoveIntent;
  readonly beforeDispatch: (
    identity: NonNullable<V2WorkspaceMoveIntent["expectedIdentity"]>,
  ) => Promise<void>;
}) {
  const { client, intent } = input;
  if (
    !intent.nativeSessionId ||
    !intent.sourceDirectory ||
    !intent.destinationDirectory ||
    intent.sourceDirectory === intent.destinationDirectory
  ) {
    throw new Error("V2 workspace move requires exact distinct native Locations.");
  }
  if (intent.dispatched && !intent.expectedIdentity) {
    throw new Error(
      "V2 workspace move reconciliation requires durable native identity; reconcile before retrying.",
    );
  }
  const read = async () =>
    decodeV2NativeSession(
      await v2Request("workspace move exact owner", (signal) =>
        client.session.get({ sessionID: intent.nativeSessionId }, { signal }),
      ),
    );
  const before = await read();
  if (before.id !== intent.nativeSessionId)
    throw new Error("V2 workspace move native owner mismatch.");
  const identity = {
    created: before.time.created,
    model: before.model ?? null,
    metadata: before.metadata ?? null,
  };
  if (intent.expectedIdentity && !isDeepStrictEqual(identity, intent.expectedIdentity)) {
    throw new Error("V2 workspace move retained native identity changed; recovery required.");
  }
  if (
    before.location.directory !== intent.sourceDirectory &&
    !(intent.dispatched && before.location.directory === intent.destinationDirectory)
  ) {
    throw new Error("V2 workspace move observed an unrecorded Location; recovery required.");
  }
  const assertIdle = async () => {
    const active = await v2Request("workspace move native activity", (signal) =>
      client.session.active({ signal }),
    );
    for (const nativeId of Object.keys(active)) {
      if (nativeId === intent.nativeSessionId)
        throw new Error("V2 workspace move requires an idle native session.");
      const other = decodeV2NativeSession(
        await v2Request("workspace move active neighbor", (signal) =>
          client.session.get({ sessionID: nativeId }, { signal }),
        ),
      );
      if (
        other.location.directory === intent.sourceDirectory ||
        other.location.directory === intent.destinationDirectory
      ) {
        throw new Error("V2 workspace move conflicts with active native work in this Location.");
      }
    }
    const inbox = await v2Request("workspace move native inbox", (signal) =>
      client.session.inbox.list({ sessionID: intent.nativeSessionId }, { signal }),
    );
    if (inbox.length) throw new Error("V2 workspace move requires the native inbox to be empty.");
  };
  await assertIdle();
  if (before.location.directory === intent.destinationDirectory) return identity;
  // Recovery never resends an uncertain native mutation. An old Location needs explicit review.
  if (intent.dispatched)
    throw new Error(
      "V2 workspace move dispatch is unconfirmed at the original Location; reconcile before retrying.",
    );
  await input.beforeDispatch(identity);
  await v2Request("workspace move", (signal) =>
    client.session.move(
      {
        sessionID: intent.nativeSessionId,
        directory: intent.destinationDirectory,
        delivery: "queue",
      },
      { signal },
    ),
  );
  const after = await read();
  if (
    after.id !== intent.nativeSessionId ||
    after.location.directory !== intent.destinationDirectory ||
    !isDeepStrictEqual(
      { created: after.time.created, model: after.model ?? null, metadata: after.metadata ?? null },
      identity,
    )
  ) {
    throw new Error(
      "V2 workspace move is not verified; native context ownership and Location require recovery.",
    );
  }
  await assertIdle();
  return identity;
}
