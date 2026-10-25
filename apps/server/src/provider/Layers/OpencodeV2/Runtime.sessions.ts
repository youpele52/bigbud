import type { ModelRef, SessionInfo } from "@opencode/client";
import path from "node:path";
import { Effect } from "effect";
import { v2Request } from "./Client.ts";
import { assertV2SavedGrantsCompatible } from "./Runtime.permissions.saved.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession, V2StartInput } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";
import { resolveV2RuntimeBinding } from "./Runtime.binding.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";
import { v2SharedProtectedResources } from "./Runtime.policy.shared.paths.ts";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import { decodeV2NativeSession } from "./Runtime.session.decode.ts";
import { assertV2ThreadPolicy } from "./Orchestration.admission.ts";
import {
  prepareSharedCreation,
  findSharedSession,
  conservedSharedPolicy,
} from "./Runtime.sessions.shared.ts";
import { awaitV2RuntimeReady, V2PreAdmissionRetry } from "./Runtime.activation.ts";
import {
  matchesV2NativeRegistration,
  v2NativeRegistrationMetadata,
} from "./Runtime.registration.ts";

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
  session: Pick<V2RuntimeSession, "native" | "storageIdentity" | "model"> &
    Partial<Pick<V2RuntimeSession, "sharedTransport">>,
  connectionMode?: "shared" | "isolated",
) {
  return {
    provider: "opencodeV2",
    nativeSessionId: session.native.id,
    storageIdentity: session.storageIdentity,
    directory: session.native.location.directory,
    model: { ...session.model },
    connectionMode: connectionMode ?? (session.sharedTransport ? "shared" : "isolated"),
    identityVersion: 1,
    ...(session.native.metadata?.bigbud_registration === "scoped"
      ? {
          identityVersion: 2,
          profileIssuer: session.native.metadata.bigbud_issuer,
          registrationFamily: "scoped",
        }
      : {}),
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
  const binding = await resolveV2RuntimeBinding(options, input);
  const { runtimeTarget, workspaceTarget, root, directory, storageIdentity, nativeSessionId } =
    binding;
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
      "V2 retained admission belongs to another native storage/target. Existing history is read-only here; no session was created, rebound or replayed.",
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
  const cursor = input.resumeCursor === undefined ? undefined : decodeV2Cursor(input.resumeCursor);
  if (cursor) {
    if (
      cursor.nativeSessionId !== nativeSessionId ||
      cursor.storageIdentity !== storageIdentity ||
      cursor.directory !== directory ||
      (cursor.connectionMode !== undefined &&
        cursor.connectionMode !== (options.config.sharedService ? "shared" : "isolated"))
    ) {
      throw new Error("V2 resume ownership mismatch; no fresh-session fallback.");
    }
  }
  // Attach retained history before applying a new turn selection through the idle switch guard.
  const model: ModelRef = cursor?.model ?? {
    providerID: selection.subProviderID,
    id: selection.model,
    ...(selection.options?.variant ? { variant: selection.options.variant } : {}),
  };
  const localTools = options.enableLocalTools === true && !disableTools;
  let permissions = options.config.sharedService
    ? v2SharedToolPolicy(
        input.runtimeMode,
        undefined,
        localTools,
        options.config.sharedService.registrationFile,
      )
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
  if (options.nativeSubagents)
    permissions.push(
      ...v2SharedProtectedResources([
        path.join(options.nativeSubagents.stateDirectory, "opencode-v2-native-families"),
      ]).flatMap((resource) =>
        ["read", "edit", "external_directory"].map((action) => ({
          action,
          resource,
          effect: "deny" as const,
        })),
      ),
    );
  cancellation?.throwIfAborted();
  let shared: Awaited<ReturnType<typeof prepareSharedCreation>> | undefined;
  let activation: V2RuntimeSession["activation"];
  const acquire = async (): Promise<Omit<V2RuntimeSession, "unregister" | "unsubscribeDeath">> => {
    mutations?.assertSafe();
    cancellation?.throwIfAborted();
    const lease = await options.manager.acquire(options.config);
    try {
      cancellation?.throwIfAborted();
      mutations?.assertSafe();
      const ready = await awaitV2RuntimeReady(
        options,
        lease.process.client,
        directory,
        cancellation,
        !localTools,
        { ...binding, threadId: input.threadId },
      );
      cancellation?.throwIfAborted();
      return await mutations.withNamespace(async () => {
        mutations.assertSafe();
        cancellation?.throwIfAborted();
        if (ready) {
          const token = ready.gate.tryReserve(
            ready.stamp,
            JSON.stringify(["startup", storageIdentity, nativeSessionId, input.sessionEpoch ?? 0]),
          );
          if (!token) throw new V2PreAdmissionRetry();
          activation = { ...ready, token, phase: "startup" };
        }
        if (options.config.sharedService)
          await options.activation?.beforeSharedHistory?.({
            storageIdentity,
            nativeSessionId,
            threadId: input.threadId,
            directory,
            client: lease.process.client,
            transport: options.config.sharedService.registrationFile,
          });
        shared = options.config.sharedService
          ? await prepareSharedCreation(options, input, binding, model, permissions)
          : undefined;
        let sharedRow = shared?.row;
        const verify = async () => {
          if (cancellation?.aborted || !lease.process.isRunning()) return false;
          const observed = decodeV2NativeSession(
            await v2Request(
              "startup session.verify",
              (signal) =>
                lease.process.client.session.get({ sessionID: nativeSessionId }, { signal }),
              requests,
            ),
          );
          return (
            observed.id === nativeSessionId &&
            matchesV2NativeRegistration(observed, binding) &&
            observed.location.directory === directory &&
            observed.metadata?.bigbud_thread === input.threadId &&
            observed.metadata.bigbud_storage === storageIdentity &&
            JSON.stringify(observed.permissions) === JSON.stringify(permissions)
          );
        };
        const mutate = <T>(operation: string, request: (signal: AbortSignal) => Promise<T>) =>
          mutations.runOwned(
            lease.process,
            operation,
            (signal) =>
              activation?.token
                ? activation.gate.dispatch(activation.token, () => request(signal))
                : request(signal),
            verify,
            10000,
            cancellation,
            true,
            () => {
              if (activation?.token) activation.gate.assertReservation(activation.token);
            },
          );
        let native: SessionInfo;
        let found: SessionInfo | undefined = shared
          ? await findSharedSession(lease.process.client, nativeSessionId, cancellation)
          : undefined;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        if (!shared)
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
            if (cursors.has(cursor) || page === 99)
              throw new Error("V2 incomplete session inventory.");
            cursors.add(cursor);
          }
        if (found)
          native = decodeV2NativeSession(
            await v2Request(
              "session.get",
              (signal) =>
                lease.process.client.session.get({ sessionID: nativeSessionId }, { signal }),
              requests,
            ),
          );
        else {
          // A resume must never manufacture new native history. A deterministic creation ID
          // prevents a lost creation acknowledgement from silently creating a second session.
          if (input.resumeCursor !== undefined || retained || (shared && !shared.canCreate))
            throw new Error(
              "V2 bound session unavailable; retained creation/admission intent, no replacement.",
            );
          // Existing history/replay can rebind without current availability; only fresh history needs preflight.
          await assertV2ModelAvailable(lease.process.client, directory, model, cancellation);
          await options.authorizeExecution?.();
          cancellation?.throwIfAborted();
          mutations.assertSafe();
          if (!lease.process.isRunning()) throw new Error("V2 startup process is unavailable.");
          if (activation?.token) activation.gate.assertReservation(activation.token);
          if (shared) sharedRow = await shared.dispatch();
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
                  ...v2NativeRegistrationMetadata(binding),
                },
                permissions,
              },
              { signal },
            ),
          );
        }
        if (shared) {
          const observed = await findSharedSession(
            lease.process.client,
            nativeSessionId,
            cancellation,
          );
          if (!observed)
            throw new Error(
              "V2 creation/history verification unavailable; intent retained, no resend.",
            );
          native = observed;
        }
        if (
          native.id !== nativeSessionId ||
          !matchesV2NativeRegistration(native, binding) ||
          native.location.directory !== directory ||
          native.metadata?.bigbud_provider !== "opencodeV2" ||
          native.metadata.bigbud_thread !== input.threadId ||
          native.metadata.bigbud_storage !== storageIdentity ||
          Boolean(shared && (native.parentID || native.fork)) ||
          !lease.process.isRunning()
        ) {
          throw new Error("V2 native session ownership rejected.");
        }
        assertV2Model(native.model, model);
        if (shared?.row.identityKind === "adopted-legacy-v1")
          permissions = conservedSharedPolicy(native.permissions, permissions);
        if (options.threadBridge && localTools)
          assertV2ThreadPolicy({ toolPolicy: permissions, native });
        if (shared && sharedRow) await shared.verify(sharedRow);
        if (localTools)
          await assertV2SavedGrantsCompatible(lease.process.client, native, permissions);
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
          ...(activation ? { activation } : {}),
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
            model: model.id,
            createdAt: now,
            updatedAt: now,
            sessionEpoch: input.sessionEpoch ?? 0,
            resumeCursor: v2ResumeCursor(
              { native, storageIdentity, model },
              options.config.sharedService ? "shared" : "isolated",
            ),
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
      });
    } catch (error) {
      if (activation?.token && !activation.gate.cancelUndispatched(activation.token))
        activation.phase = "uncertain";
      await lease.release();
      throw error;
    }
  };
  for (let retry = 0; retry < 3; retry++) {
    try {
      return await acquire();
    } catch (error) {
      if (!(error instanceof V2PreAdmissionRetry) || retry === 2) throw error;
      cancellation?.throwIfAborted();
    }
  }
  throw new V2PreAdmissionRetry();
}
