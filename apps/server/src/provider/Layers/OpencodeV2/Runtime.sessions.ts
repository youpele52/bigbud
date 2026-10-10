import type { ModelRef, SessionInfo } from "@opencode/client";
import { Effect, Schema } from "effect";
import { v2Request } from "./Client.ts";
import { assertV2NoSavedGrants } from "./Runtime.permissions.saved.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession, V2StartInput } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { resolveV2RuntimeBinding } from "./Runtime.binding.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";

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

export function v2ResumeCursor(
  session: Pick<V2RuntimeSession, "native" | "storageIdentity" | "model">,
) {
  return {
    provider: "opencodeV2",
    nativeSessionId: session.native.id,
    storageIdentity: session.storageIdentity,
    directory: session.native.location.directory,
    model: { ...session.model },
  } as const;
}

/** Create/rebind only the exact app-prepared owned workspace and storage identity. */
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
  const { runtimeTarget, workspaceTarget, root, directory, storageIdentity, nativeSessionId } =
    await resolveV2RuntimeBinding(options, input);
  const retained = await Effect.runPromise(options.journal.latestBound(input.threadId));
  if (
    retained &&
    (retained.binding.storageIdentity !== storageIdentity ||
      retained.binding.nativeSessionId !== nativeSessionId ||
      retained.binding.location !== directory ||
      retained.binding.runtimeTargetId !== runtimeTarget ||
      retained.binding.workspaceTargetId !== workspaceTarget)
  )
    throw new Error(
      "V2 retained admission belongs to another native storage/target. Reopen its original connection mode or start a new chat; no session was created or history rebound.",
    );
  const selection = input.modelSelection;
  if (
    !selection ||
    selection.provider !== "opencodeV2" ||
    !selection.subProviderID ||
    selection.model === "default"
  ) {
    throw new Error("V2 requires an explicit native provider/model.");
  }
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
  const permissions = options.config.sharedService
    ? v2SharedToolPolicy(input.runtimeMode, options.config.sharedService.databasePath, localTools)
    : v2LocalToolPolicy(input.runtimeMode, localTools, Boolean(options.codingBridge), {
        nativeWorkspace: runtimeTarget === workspaceTarget,
        profileRoot: root,
        boundedFiles:
          runtimeTarget !== "local" ||
          workspaceTarget !== "local" ||
          Boolean(options.codingBridge?.supportsLocalFiles),
      });
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
        // Existing history/replay can rebind without current availability; only fresh history needs preflight.
        await assertV2ModelAvailable(lease.process.client, directory, model, cancellation);
        await options.authorizeExecution?.();
        cancellation?.throwIfAborted();
        mutations.assertSafe();
        if (!lease.process.isRunning()) throw new Error("V2 startup process is unavailable.");
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
      if (localTools) await assertV2NoSavedGrants(lease.process.client, native);
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
          resumeCursor: v2ResumeCursor({ native, storageIdentity, model }),
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
