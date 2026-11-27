import { version } from "../../package.json" with { type: "json" };
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { OwnershipShutdown } from "./ownershipShutdown.ts";
import { armBackendDrainExit } from "./backendDrain.exit.ts";
import { registerBackendDrainHandler, type BackendDrainHandler } from "./backendDrain.handler.ts";
import { requestBackendDrainConsent, type BackendDrainDecision } from "./backendDrain.consent.ts";
import {
  runLegacyDrain,
  type LegacyDrainChoice,
  type LegacyDrainPane,
} from "../ssh/sshLegacyDrain.ts";
import { drainOwnedSshMasters } from "../ssh/sshSession.ts";
import { getPeerCoordinator } from "../peer-orchestration/peerCoordinator.layer.ts";
import { stopAllSshMonitorTargets } from "../ssh/sshMonitor.connections.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  registerBackendDrainStop,
  runBackendDrainStopStep,
  type BackendDrainStopReport,
} from "./backendDrain.stops.ts";

/** Stops every live provider session; a failed stop fails the drain's stop phase. */
export const stopProviderSessions = (service: ProviderServiceShape) =>
  service.listSessions().pipe(
    Effect.flatMap((sessions) =>
      Effect.forEach(sessions, (session) => service.stopSession({ threadId: session.threadId }), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.as(sessions.length)),
    ),
  );

const registerProviderDrainStop = (service: ProviderServiceShape) =>
  registerBackendDrainStop("providers", () => Effect.runPromise(stopProviderSessions(service)));

export interface LiveBackendDrainDeps {
  readonly profileScope: string;
  readonly artifactId: string;
  readonly listPanes: () => Effect.Effect<ReadonlyArray<LegacyDrainPane>>;
  readonly closePane: (pane: LegacyDrainPane) => Effect.Effect<void, Error>;
  /** Real stop effects; a `BackendDrainStopReport` result is reported in the response. */
  readonly stopMonitors: Effect.Effect<unknown, Error>;
  readonly stopRelays: Effect.Effect<unknown, Error>;
  readonly stopProviders: Effect.Effect<unknown, Error>;
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

/** Tagged drain errors carry their text in `detail`; never answer an empty message. */
const drainFailureMessage = (cause: unknown) => {
  const detail = (cause as { readonly detail?: unknown } | null)?.detail;
  const message = typeof detail === "string" && detail.length > 0 ? detail : asError(cause).message;
  return (message.length > 0 ? message : "The backend drain failed.").slice(0, 500);
};

const isStopReport = (value: unknown): value is BackendDrainStopReport =>
  typeof value === "object" && value !== null && "step" in value && "stopped" in value;

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
    const stops: BackendDrainStopReport[] = [];
    const reported = (stop: Effect.Effect<unknown, Error>) =>
      stop.pipe(
        Effect.tap((result) => Effect.sync(() => isStopReport(result) && stops.push(result))),
        Effect.asVoid,
      );
    try {
      if (deps.drainFollowers) await Effect.runPromise(deps.drainFollowers());
      const panes = await Effect.runPromise(deps.listPanes());
      let choice: LegacyDrainChoice = "drain-now";
      if (request.consent === "ui") {
        const decision = await Effect.runPromise(
          requestBackendDrainConsent({
            panes,
            // Never outlive the caller's wait: a late decision after the client gave up
            // must not drain an upgrade that was already reported as not started.
            timeoutMs: Math.min(deps.consentTimeoutMs ?? 120_000, request.waitMs),
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
          stopMonitors: reported(deps.stopMonitors),
          stopRelays: reported(deps.stopRelays),
          stopProviders: reported(deps.stopProviders),
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
        ? { v: 1, ok: true, status: "drained", stops }
        : { v: 1, ok: true, status: "cancelled" };
    } catch (cause) {
      return {
        v: 1,
        ok: false,
        error: { code: "failed", message: drainFailureMessage(cause) },
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
    const provider = yield* Effect.serviceOption(ProviderService);
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
      stopMonitors: runBackendDrainStopStep("monitors"),
      stopRelays: runBackendDrainStopStep("relays"),
      stopProviders: runBackendDrainStopStep("providers"),
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
        onSome: (service) =>
          Effect.sync(() => {
            service.request();
            armBackendDrainExit();
          }),
      }),
    });
    const unregister = registerBackendDrainHandler(handler);
    const unregisterMonitors = registerBackendDrainStop("monitors", async () =>
      stopAllSshMonitorTargets(),
    );
    const unregisterProviders = Option.match(provider, {
      onNone: () => () => {},
      onSome: registerProviderDrainStop,
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregister();
        unregisterMonitors();
        unregisterProviders();
      }),
    );
  }),
);
