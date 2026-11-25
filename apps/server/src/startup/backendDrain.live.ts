import { version } from "../../package.json" with { type: "json" };
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { OwnershipShutdown } from "./ownershipShutdown.ts";
import { registerBackendDrainHandler, type BackendDrainHandler } from "./backendDrain.handler.ts";
import { requestBackendDrainConsent, type BackendDrainDecision } from "./backendDrain.consent.ts";
import {
  runLegacyDrain,
  type LegacyDrainChoice,
  type LegacyDrainPane,
} from "../ssh/sshLegacyDrain.ts";
import { drainOwnedSshMasters } from "../ssh/sshSession.ts";
import { getPeerCoordinator } from "../peer-orchestration/peerCoordinator.layer.ts";

export interface LiveBackendDrainDeps {
  readonly profileScope: string;
  readonly artifactId: string;
  readonly listPanes: () => Effect.Effect<ReadonlyArray<LegacyDrainPane>>;
  readonly closePane: (pane: LegacyDrainPane) => Effect.Effect<void, Error>;
  readonly stopMonitors: Effect.Effect<void, Error>;
  readonly stopRelays: Effect.Effect<void, Error>;
  readonly stopProviders: Effect.Effect<void, Error>;
  readonly closeOwnedMasters: Effect.Effect<
    { readonly closed: number; readonly failed: number },
    Error
  >;
  readonly commit: (input: {
    readonly profileScope: string;
    readonly artifactId: string;
    readonly decision: LegacyDrainChoice;
    readonly drainedLeases: ReadonlyArray<string>;
    readonly pendingItems: ReadonlyArray<string>;
  }) => Effect.Effect<"committed" | "already-retired" | "conflict" | void, Error>;
  readonly releaseLock: Effect.Effect<void, Error>;
  /** Drains coordinator followers through the real peer coordinator; 0 when none. */
  readonly drainFollowers?: (() => Effect.Effect<number, Error>) | undefined;
  readonly consentTimeoutMs?: number;
}

class BackendDrainLiveError extends Data.TaggedError("BackendDrainLiveError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

const choiceFromDecision = (decision: BackendDrainDecision): LegacyDrainChoice | undefined =>
  decision.kind === "proceed" ? decision.choice : undefined;

/**
 * Builds the registered handler. The UI consent snapshot is published before
 * any stop, close, master exit or transaction; cancel/timeout returns before
 * the core is called. A non-interactive request skips the snapshot only when the
 * CLI recorded `--i-have-saved-my-work`.
 */
export function makeLiveBackendDrainHandler(deps: LiveBackendDrainDeps): BackendDrainHandler {
  let running = false;
  return async (request) => {
    if (request.artifactId !== deps.artifactId)
      return { v: 1, ok: true, status: "unknown-artifact" };
    if (running) return { v: 1, ok: true, status: "busy" };
    running = true;
    try {
      if (deps.drainFollowers) await Effect.runPromise(deps.drainFollowers());
      const panes = await Effect.runPromise(deps.listPanes());
      let choice: LegacyDrainChoice = "drain-now";
      if (request.consent === "ui") {
        const decision = await Effect.runPromise(
          requestBackendDrainConsent({
            panes,
            timeoutMs: deps.consentTimeoutMs ?? 120_000,
            drainId: `drain-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
          }),
        );
        if (decision.kind === "consent-required")
          return { v: 1, ok: true, status: "consent-required" };
        if (decision.kind === "busy") return { v: 1, ok: true, status: "busy" };
        if (decision.kind === "cancelled") return { v: 1, ok: true, status: "cancelled" };
        const selected = choiceFromDecision(decision);
        if (selected) choice = selected;
      }
      const outcome = await Effect.runPromise(
        runLegacyDrain({
          trigger: "cli-for-upgrade",
          profileScope: deps.profileScope,
          artifactId: deps.artifactId,
          stopMonitors: deps.stopMonitors,
          stopRelays: deps.stopRelays,
          stopProviders: deps.stopProviders,
          listPanes: Effect.succeed(panes),
          consent: () => Effect.succeed({ kind: "proceed", choice }),
          closePane: deps.closePane,
          closeOwnedMasters: deps.closeOwnedMasters,
          commit: deps.commit,
          releaseLock: deps.releaseLock,
          timeoutMs: 60_000,
        }),
      ).catch((cause: unknown) => {
        throw asError(cause);
      });
      return outcome.kind === "drained"
        ? { v: 1, ok: true, status: "drained" }
        : { v: 1, ok: true, status: "cancelled" };
    } catch (cause) {
      return {
        v: 1,
        ok: false,
        error: { code: "failed", message: asError(cause).message.slice(0, 500) },
      };
    } finally {
      running = false;
    }
  };
}

/** Composition layer: register under the held lock and unregister on teardown. */
export const SshLegacyDrainHandlerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const manager = yield* TerminalManager;
    const sql = yield* SqlClient.SqlClient;
    const shutdown = yield* Effect.serviceOption(OwnershipShutdown);
    const handler = makeLiveBackendDrainHandler({
      profileScope: "backend",
      artifactId: `bigbud-server@${version}`,
      listPanes: () =>
        (manager.listDrainPanes?.() ?? Effect.succeed([])).pipe(
          Effect.map((panes) =>
            panes.map(
              (pane): LegacyDrainPane => ({
                paneId: `${pane.threadId}:${pane.terminalId}`,
                threadId: pane.threadId,
                threadTitle: pane.threadId,
                title: pane.terminalId,
                surface:
                  pane.surface === "direct-ssh"
                    ? "direct-ssh"
                    : pane.surface === "remote-agent"
                      ? "remote-agent"
                      : "local",
                leaseId: `${pane.threadId}:${pane.terminalId}`,
                keepMode: pane.keepMode,
              }),
            ),
          ),
        ),
      closePane: (pane) =>
        manager
          .close({ threadId: pane.threadId, terminalId: pane.paneId.split(":")[1]! })
          .pipe(Effect.mapError(asError), Effect.asVoid),
      stopMonitors: Effect.logInfo("drain: stopping SSH monitors").pipe(Effect.asVoid),
      stopRelays: Effect.logInfo("drain: stopping relays").pipe(Effect.asVoid),
      stopProviders: Effect.logInfo("drain: stopping providers").pipe(Effect.asVoid),
      closeOwnedMasters: Effect.tryPromise({
        try: () => drainOwnedSshMasters(),
        catch: (cause) => new BackendDrainLiveError({ detail: "SSH master drain failed.", cause }),
      }),
      commit: (input) =>
        commitLegacyRetirement(sql, input).pipe(
          Effect.map((result) => result),
          Effect.mapError(asError),
        ),
      drainFollowers: () => {
        const coordinator = getPeerCoordinator();
        // Local mode has no peer coordinator and therefore no followers.
        if (!coordinator) return Effect.succeed(0);
        return coordinator.service.drainFollowers();
      },
      releaseLock: Option.match(shutdown, {
        onNone: () =>
          Effect.fail(
            new Error(
              "The backend has no shutdown request; the drain cannot release the lock for the upgrade.",
            ),
          ),
        onSome: (service) => Effect.sync(() => service.request()),
      }),
    });
    const unregister = registerBackendDrainHandler(handler);
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
  }),
);
