import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ModelRef, SessionInfo } from "@opencode/client";
import { Schema } from "effect";
import { v2Request } from "./Client.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession, V2StartInput } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";

const Cursor = Schema.Struct({
  provider: Schema.Literal("opencodeV2"),
  nativeSessionId: Schema.String,
  storageIdentity: Schema.String,
  directory: Schema.String,
});

/** Rebinding is unsupported; compare native selection, not just the runtime fingerprint. */
export function assertV2Model(actual: ModelRef | undefined, requested: ModelRef): void {
  if (
    actual?.providerID !== requested.providerID ||
    actual.id !== requested.id ||
    (actual.variant ?? "default") !== (requested.variant ?? "default")
  )
    throw new Error("V2 native model/variant rebind is unsupported; existing history retained.");
}

export function v2ResumeCursor(session: V2RuntimeSession) {
  return {
    provider: "opencodeV2",
    nativeSessionId: session.native.id,
    storageIdentity: session.storageIdentity,
    directory: session.native.location.directory,
  } as const;
}

export function v2StorageIdentity(runtimeTargetId: string, root: string) {
  return createHash("sha256")
    .update(JSON.stringify([runtimeTargetId, root]))
    .digest("hex");
}

/** Owned isolated workspace only; real/remote workspaces require a separate conformance gate. */
export async function createRuntimeSession(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  mutations: V2RuntimeMutations,
  cancellation?: AbortSignal,
  disableTools = false,
): Promise<Omit<V2RuntimeSession, "unregister" | "unsubscribeDeath">> {
  const requests = cancellation ? { signal: cancellation } : {};
  if (input.provider !== undefined && input.provider !== "opencodeV2")
    throw new Error("V2 provider mismatch.");
  const runtimeTarget =
    input.providerRuntimeExecutionTargetId ??
    input.executionTargetId ??
    options.config.runtimeTargetId;
  const workspaceTarget =
    input.workspaceExecutionTargetId ?? input.executionTargetId ?? runtimeTarget;
  const remote = runtimeTarget !== "local" || workspaceTarget !== "local";
  const authorization = options.remoteSessionConformance;
  if (
    runtimeTarget !== options.config.runtimeTargetId ||
    (remote &&
      (!authorization ||
        authorization.providerRuntimeTargetId !== runtimeTarget ||
        authorization.workspaceTargetId !== workspaceTarget ||
        authorization.profileRoot !== options.config.profileRoot ||
        authorization.syntheticDirectory !== input.cwd))
  )
    throw new Error("V2 remote runtime/workspace is not verified.");
  const selection = input.modelSelection;
  if (
    !selection ||
    selection.provider !== "opencodeV2" ||
    !selection.subProviderID ||
    selection.model === "default"
  ) {
    throw new Error("V2 requires an explicit native provider/model.");
  }
  if (!input.cwd) throw new Error("V2 requires an isolated workspace.");
  const remoteFilesystem = runtimeTarget !== "local";
  const root = remoteFilesystem
    ? path.posix.resolve(options.config.profileRoot)
    : await realpath(options.config.profileRoot);
  const directory = remoteFilesystem ? path.posix.resolve(input.cwd) : await realpath(input.cwd);
  if (!remote) {
    await assertV2WorkspaceStorageSeparate(root, directory);
  }
  const storageIdentity = v2StorageIdentity(options.config.runtimeTargetId, root);
  const nativeSessionId = `ses_bigbud_${createHash("sha256")
    .update(JSON.stringify([storageIdentity, input.threadId]))
    .digest("hex")}`;
  if (input.resumeCursor !== undefined) {
    const cursor = Schema.decodeUnknownSync(Cursor)(input.resumeCursor);
    if (
      cursor.nativeSessionId !== nativeSessionId ||
      cursor.storageIdentity !== storageIdentity ||
      cursor.directory !== directory
    ) {
      throw new Error("V2 resume ownership mismatch; no fresh-session fallback.");
    }
  }
  const model: ModelRef = {
    providerID: selection.subProviderID,
    id: selection.model,
    ...(selection.options?.variant ? { variant: selection.options.variant } : {}),
  };
  const localTools = options.enableLocalTools === true && !disableTools;
  const permissions = v2LocalToolPolicy(
    input.runtimeMode,
    localTools,
    Boolean(options.codingBridge),
    {
      nativeWorkspace: runtimeTarget === workspaceTarget,
      profileRoot: root,
      boundedFiles:
        runtimeTarget !== "local" ||
        workspaceTarget !== "local" ||
        Boolean(options.codingBridge?.supportsLocalFiles),
    },
  );
  cancellation?.throwIfAborted();
  await options.authorizeExecution?.();
  cancellation?.throwIfAborted();
  const acquire = async (): Promise<Omit<V2RuntimeSession, "unregister" | "unsubscribeDeath">> => {
    mutations?.assertSafe();
    cancellation?.throwIfAborted();
    const lease = await options.manager.acquire(options.config);
    try {
      cancellation?.throwIfAborted();
      mutations?.assertSafe();
      const verify = async () => {
        if (cancellation?.aborted || !lease.process.isRunning()) return false;
        const observed = await v2Request(
          "startup session.verify",
          (signal) => lease.process.client.session.get({ sessionID: nativeSessionId }, { signal }),
          requests,
        );
        return (
          observed.id === nativeSessionId &&
          observed.location.directory === directory &&
          observed.metadata?.bigbud_thread === input.threadId &&
          observed.metadata.bigbud_storage === storageIdentity &&
          JSON.stringify(observed.permissions) === JSON.stringify(permissions)
        );
      };
      const mutate = <T>(operation: string, request: (signal: AbortSignal) => Promise<T>) =>
        mutations.runOwned(lease.process, operation, request, verify, 10000, cancellation, true);
      let native: SessionInfo;
      let found: SessionInfo | undefined;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const listing = await v2Request(
          "session.list",
          (signal) =>
            lease.process.client.session.list(
              { directory, limit: 200, ...(cursor ? { cursor } : {}) },
              { signal },
            ),
          requests,
        );
        if (listing.data.length > 200) throw new Error("V2 session listing bound exceeded.");
        found = listing.data.find((session) => session.id === nativeSessionId);
        if (found || !listing.cursor.next) break;
        cursor = listing.cursor.next;
        if (cursors.has(cursor) || page === 99) throw new Error("V2 incomplete session inventory.");
        cursors.add(cursor);
      }
      if (found)
        native = await v2Request(
          "session.get",
          (signal) => lease.process.client.session.get({ sessionID: nativeSessionId }, { signal }),
          requests,
        );
      else {
        // A resume must never manufacture new native history. A deterministic creation ID
        // prevents a lost creation acknowledgement from silently creating a second session.
        if (input.resumeCursor !== undefined) throw new Error("V2 bound session unavailable.");
        native = await mutate("session.create", (signal) =>
          lease.process.client.session.create(
            {
              id: nativeSessionId,
              location: { directory },
              model,
              metadata: {
                bigbud_provider: "opencodeV2",
                bigbud_thread: input.threadId,
                bigbud_storage: storageIdentity,
              },
              permissions,
            },
            { signal },
          ),
        );
      }
      if (
        native.id !== nativeSessionId ||
        native.location.directory !== directory ||
        native.metadata?.bigbud_provider !== "opencodeV2" ||
        native.metadata.bigbud_thread !== input.threadId ||
        native.metadata.bigbud_storage !== storageIdentity ||
        !lease.process.isRunning()
      ) {
        throw new Error("V2 native session ownership rejected.");
      }
      assertV2Model(native.model, model);
      // Reset only this owned session's permissions. Never trust persisted broad approvals.
      mutations?.assertSafe();
      cancellation?.throwIfAborted();
      await mutate("session.update", (signal) =>
        lease.process.client.session.update(
          {
            sessionID: native.id,
            permissions,
          },
          { signal },
        ),
      );
      cancellation?.throwIfAborted();
      mutations?.assertSafe();
      const now = new Date().toISOString();
      return {
        threadId: input.threadId,
        native,
        lease,
        model,
        storageIdentity,
        epoch: input.sessionEpoch ?? 0,
        session: {
          provider: "opencodeV2",
          threadId: input.threadId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          providerRuntimeExecutionTargetId: runtimeTarget,
          workspaceExecutionTargetId: workspaceTarget,
          cwd: directory,
          model: selection.model,
          createdAt: now,
          updatedAt: now,
          sessionEpoch: input.sessionEpoch ?? 0,
          resumeCursor: { provider: "opencodeV2", nativeSessionId, storageIdentity, directory },
        },
        stopped: false,
        localTools,
        toolPolicy: permissions,
        executionPolicy: v2ExecutionPolicy(input.runtimeMode, localTools, permissions),
        dirtyGeneration: 0,
        repairQueued: false,
        terminalDelivered: false,
        operation: Promise.resolve(),
        emitted: new Set(),
        messages: new Map(),
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  };
  return mutations.withNamespace(acquire);
}
