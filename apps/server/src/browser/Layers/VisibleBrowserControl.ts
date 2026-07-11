import type {
  BrowserResult,
  VisibleBrowserCommand,
  VisibleBrowserLeaseSnapshot,
} from "@bigbud/contracts";
import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  VisibleBrowserControl,
  VisibleBrowserControlError,
  type VisibleBrowserControlShape,
} from "../Services/VisibleBrowserControl.ts";
import {
  type Lease,
  makeVisibleBrowserState,
  type PendingCommand,
  type ReleasedLeases,
  removeRenderer,
  type VisibleBrowserState as State,
} from "./VisibleBrowserControl.state.ts";

const COMMAND_TIMEOUT = "15 seconds";

const makeVisibleBrowserControl = Effect.fn("makeVisibleBrowserControl")(function* () {
  const commands = yield* PubSub.unbounded<VisibleBrowserCommand>();
  const state = yield* Ref.make<State>(makeVisibleBrowserState());

  const isAvailable = Ref.get(state).pipe(Effect.map((current) => current.renderers.length > 0));

  const execute: VisibleBrowserControlShape["execute"] = (input) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const existingLease = input.action.tabId
        ? [...current.leases.values()].find((lease) => lease.tabId === input.action.tabId)
        : undefined;
      const createdTab =
        input.action.action === "close_tab"
          ? current.createdTabs.get(input.action.tabId)
          : undefined;
      const revokedTab = input.action.tabId
        ? current.revokedTabs.get(input.action.tabId)
        : undefined;
      if (
        revokedTab &&
        revokedTab.threadId === input.threadId &&
        revokedTab.turnId === input.turnId
      ) {
        return yield* new VisibleBrowserControlError({
          message: "The visible browser tab was closed by the user.",
        });
      }
      if (
        existingLease &&
        input.action.action !== "close_tab" &&
        (existingLease.threadId !== input.threadId || existingLease.turnId !== input.turnId)
      ) {
        return yield* new VisibleBrowserControlError({
          message: "That visible browser tab is controlled by another active thread.",
        });
      }

      const rendererId =
        existingLease?.rendererId ?? createdTab?.rendererId ?? current.renderers.at(-1);
      if (!rendererId || !current.renderers.includes(rendererId)) {
        return yield* new VisibleBrowserControlError({
          message: existingLease
            ? "The visible browser tab is reconnecting. Try again once it is connected."
            : "The visible bigbud browser is not connected.",
        });
      }

      const leaseId = existingLease?.leaseId ?? crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const deferred = yield* Deferred.make<BrowserResult, VisibleBrowserControlError>();
      const command: VisibleBrowserCommand = {
        commandId,
        leaseId,
        rendererId,
        threadId: input.threadId,
        turnId: input.turnId,
        action: input.action,
      };

      const interrupted = yield* Ref.modify(
        state,
        (previous): readonly [ReadonlyArray<PendingCommand>, State] => {
          const leases = new Map(previous.leases);
          if (existingLease && input.action.action === "close_tab") {
            leases.set(existingLease.leaseId, {
              ...existingLease,
              threadId: input.threadId,
              turnId: input.turnId,
            });
          } else if (!existingLease) {
            leases.set(leaseId, {
              leaseId,
              threadId: input.threadId,
              turnId: input.turnId,
              rendererId,
              tabId: input.action.tabId ?? null,
              openedByAgent:
                input.action.action !== "close_tab" && input.action.tabId === undefined,
            });
          }
          const pending = new Map(previous.pending);
          const interrupted: PendingCommand[] = [];
          if (input.action.action === "close_tab" && existingLease) {
            for (const [pendingCommandId, entry] of pending) {
              if (entry.command.leaseId === existingLease.leaseId) {
                pending.delete(pendingCommandId);
                interrupted.push(entry);
              }
            }
          }
          pending.set(commandId, { command, deferred });
          return [interrupted, { ...previous, leases, pending }] as const;
        },
      );
      yield* Effect.forEach(
        interrupted,
        (entry) =>
          Deferred.fail(
            entry.deferred,
            new VisibleBrowserControlError({ message: "Browser tab closed by user request." }),
          ),
        { discard: true },
      );
      yield* PubSub.publish(commands, command);

      return yield* Deferred.await(deferred).pipe(
        Effect.timeout(COMMAND_TIMEOUT),
        Effect.mapError((error) =>
          error instanceof VisibleBrowserControlError
            ? error
            : new VisibleBrowserControlError({
                message: "The visible bigbud browser did not respond in time.",
              }),
        ),
        Effect.ensuring(
          Ref.update(state, (previous) => {
            const pending = new Map(previous.pending);
            pending.delete(commandId);
            return { ...previous, pending };
          }),
        ),
      );
    });

  const complete: VisibleBrowserControlShape["complete"] = (input) =>
    Ref.modify(state, (previous) => {
      const releaseCommand = previous.releases.get(input.commandId);
      if (releaseCommand?.rendererId === input.rendererId) {
        if (input.error) {
          return [undefined, previous] as const;
        }
        const releases = new Map(previous.releases);
        releases.delete(input.commandId);
        return [undefined, { ...previous, releases }] as const;
      }
      const pendingEntry = previous.pending.get(input.commandId);
      if (!pendingEntry || pendingEntry.command.rendererId !== input.rendererId) {
        return [undefined, previous] as const;
      }

      const pending = new Map(previous.pending);
      pending.delete(input.commandId);
      const leases = new Map(previous.leases);
      const lease = leases.get(pendingEntry.command.leaseId);
      const createdTabs = new Map(previous.createdTabs);
      if (lease && pendingEntry.command.action.action === "close_tab") {
        leases.delete(lease.leaseId);
        createdTabs.delete(pendingEntry.command.action.tabId);
      } else if (lease && input.result?.tabId) {
        leases.set(lease.leaseId, { ...lease, tabId: input.result.tabId });
        if (lease.openedByAgent) {
          createdTabs.set(input.result.tabId, {
            rendererId: lease.rendererId,
          });
        }
      } else if (lease?.tabId === null) {
        leases.delete(lease.leaseId);
      }
      return [pendingEntry, { ...previous, pending, leases, createdTabs }] as const;
    }).pipe(
      Effect.flatMap((pendingEntry) => {
        if (!pendingEntry) return Effect.void;
        if (input.error) {
          return Deferred.fail(
            pendingEntry.deferred,
            new VisibleBrowserControlError({ message: input.error }),
          );
        }
        if (!input.result) {
          return Deferred.fail(
            pendingEntry.deferred,
            new VisibleBrowserControlError({
              message: "Visible browser command returned no result.",
            }),
          );
        }
        return Deferred.succeed(pendingEntry.deferred, {
          ...input.result,
          target: "visible",
          leaseId: pendingEntry.command.leaseId,
        });
      }),
      Effect.asVoid,
    );

  const streamCommands: VisibleBrowserControlShape["streamCommands"] = (rendererId) =>
    Stream.unwrap(
      Ref.update(state, (current) =>
        current.renderers.includes(rendererId)
          ? current
          : { ...current, renderers: [...current.renderers, rendererId] },
      ).pipe(
        Effect.flatMap(() => Ref.get(state)),
        Effect.map((current) => {
          const pendingReleases = [...current.releases.values()].filter(
            (command) => command.rendererId === rendererId,
          );
          return Stream.concat(
            Stream.fromIterable(pendingReleases),
            Stream.fromPubSub(commands).pipe(
              Stream.filter((command) => command.rendererId === rendererId),
              Stream.ensuring(
                Ref.update(state, (latest) => ({
                  ...latest,
                  renderers: removeRenderer(latest.renderers, rendererId),
                })),
              ),
            ),
          );
        }),
      ),
    );

  const reconcileThread: VisibleBrowserControlShape["reconcileThread"] = (input) =>
    Ref.modify(state, (current): readonly [ReleasedLeases, State] => {
      const releasedLeaseIds = new Set<string>();
      for (const lease of current.leases.values()) {
        if (
          lease.threadId === input.threadId &&
          (!input.isRunning || lease.turnId !== input.activeTurnId)
        ) {
          releasedLeaseIds.add(lease.leaseId);
        }
      }
      const leases = new Map(current.leases);
      const releasedLeases: Lease[] = [];
      for (const leaseId of releasedLeaseIds) {
        const lease = leases.get(leaseId);
        if (lease) {
          releasedLeases.push(lease);
        }
        leases.delete(leaseId);
      }
      const pending = new Map(current.pending);
      const releases = new Map(current.releases);
      const revokedTabs = new Map(current.revokedTabs);
      const createdTabs = new Map(current.createdTabs);
      for (const [tabId, revoked] of revokedTabs) {
        if (
          revoked.threadId === input.threadId &&
          (!input.isRunning || revoked.turnId !== input.activeTurnId)
        ) {
          revokedTabs.delete(tabId);
        }
      }
      const releasedPending: PendingCommand[] = [];
      for (const [commandId, entry] of pending) {
        if (releasedLeaseIds.has(entry.command.leaseId)) {
          pending.delete(commandId);
          releasedPending.push(entry);
        }
      }
      const releasedCommands = releasedLeases
        .filter((lease) => lease.tabId !== null)
        .map<VisibleBrowserCommand>((lease) => ({
          commandId: crypto.randomUUID(),
          leaseId: lease.leaseId,
          rendererId: lease.rendererId,
          threadId: lease.threadId,
          turnId: lease.turnId,
          action: {
            action: "release_tab",
            target: "visible",
            tabId: lease.tabId!,
          },
        }));
      for (const command of releasedCommands) {
        releases.set(command.commandId, command);
      }
      return [
        { leases: releasedLeases, pending: releasedPending, releases: releasedCommands },
        { ...current, leases, pending, releases, revokedTabs, createdTabs },
      ] as const;
    }).pipe(
      Effect.flatMap((released) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            released.pending,
            (entry) =>
              Deferred.fail(
                entry.deferred,
                new VisibleBrowserControlError({ message: "Browser lease released." }),
              ),
            { discard: true },
          );
          yield* Effect.forEach(released.releases, (command) => PubSub.publish(commands, command), {
            discard: true,
          });
        }),
      ),
      Effect.asVoid,
    );

  const revokeLease: VisibleBrowserControlShape["revokeLease"] = (input) =>
    Ref.modify(state, (current): readonly [ReadonlyArray<PendingCommand>, State] => {
      const lease = current.leases.get(input.leaseId);
      if (!lease || lease.rendererId !== input.rendererId || lease.tabId !== input.tabId) {
        return [[], current] as const;
      }

      const leases = new Map(current.leases);
      leases.delete(lease.leaseId);
      const pending = new Map(current.pending);
      const revokedPending: PendingCommand[] = [];
      for (const [commandId, entry] of pending) {
        if (entry.command.leaseId === lease.leaseId) {
          pending.delete(commandId);
          revokedPending.push(entry);
        }
      }
      const releases = new Map(current.releases);
      for (const [commandId, command] of releases) {
        if (command.leaseId === lease.leaseId) {
          releases.delete(commandId);
        }
      }
      const revokedTabs = new Map(current.revokedTabs);
      revokedTabs.set(input.tabId, { threadId: lease.threadId, turnId: lease.turnId });
      const createdTabs = new Map(current.createdTabs);
      createdTabs.delete(input.tabId);
      return [
        revokedPending,
        { ...current, leases, pending, releases, revokedTabs, createdTabs },
      ] as const;
    }).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          pending,
          (entry) =>
            Deferred.fail(
              entry.deferred,
              new VisibleBrowserControlError({ message: "Browser lease revoked by user." }),
            ),
          { discard: true },
        ),
      ),
      Effect.asVoid,
    );

  const getLeases: VisibleBrowserControlShape["getLeases"] = (rendererId) =>
    Ref.get(state).pipe(
      Effect.map((current) =>
        [...current.leases.values()].flatMap(
          (lease): ReadonlyArray<VisibleBrowserLeaseSnapshot> =>
            lease.rendererId === rendererId && lease.tabId
              ? [
                  {
                    leaseId: lease.leaseId,
                    tabId: lease.tabId,
                    threadId: lease.threadId,
                    turnId: lease.turnId,
                  },
                ]
              : [],
        ),
      ),
    );

  return {
    isAvailable,
    execute,
    complete,
    streamCommands,
    reconcileThread,
    revokeLease,
    getLeases,
  } satisfies VisibleBrowserControlShape;
});

export const VisibleBrowserControlLive = Layer.effect(
  VisibleBrowserControl,
  makeVisibleBrowserControl(),
);
