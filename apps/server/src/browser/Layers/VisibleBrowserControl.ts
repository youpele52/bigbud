import type { BrowserResult, VisibleBrowserCommand } from "@bigbud/contracts";
import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  VisibleBrowserControl,
  VisibleBrowserControlError,
  type VisibleBrowserControlShape,
} from "../Services/VisibleBrowserControl.ts";
import {
  makeVisibleBrowserState,
  type PendingCommand,
  removeRenderer,
  type VisibleBrowserState as State,
} from "./VisibleBrowserControl.state.ts";
import { makeVisibleBrowserRetentionControl } from "./VisibleBrowserControl.retention.ts";

const COMMAND_TIMEOUT = "15 seconds";
const durableLeaseId = (leaseId: string) => `visible-browser:${leaseId}`;

const makeVisibleBrowserControl = Effect.fn("makeVisibleBrowserControl")(function* () {
  const commands = yield* PubSub.unbounded<VisibleBrowserCommand>();
  const state = yield* Ref.make<State>(makeVisibleBrowserState());
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_activity_leases WHERE lease_id LIKE 'visible-browser:%'`;

  const releaseDurableLease = (leaseId: string) =>
    sql`DELETE FROM thread_activity_leases WHERE lease_id = ${durableLeaseId(leaseId)}`.pipe(
      Effect.ignore,
    );

  const isAvailable = Ref.get(state).pipe(Effect.map((current) => current.renderers.length > 0));
  const hasThreadLease: VisibleBrowserControlShape["hasThreadLease"] = (threadId) =>
    Ref.get(state).pipe(
      Effect.map((current) =>
        [...current.leases.values()].some((lease) => lease.threadId === threadId),
      ),
    );

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

      if (!existingLease && input.action.action !== "close_tab") {
        yield* sql`
          INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
          VALUES (${durableLeaseId(leaseId)}, ${input.threadId}, 'browser', ${new Date().toISOString()})
        `.pipe(
          Effect.mapError(
            () =>
              new VisibleBrowserControlError({
                message: "Browser tab cannot be opened while the thread is being deleted.",
              }),
          ),
        );
      }

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
        const shouldReleaseLease =
          input.error !== undefined ||
          pendingEntry.command.action.action === "close_tab" ||
          !input.result?.tabId;
        const release = shouldReleaseLease
          ? releaseDurableLease(pendingEntry.command.leaseId)
          : Effect.void;
        if (input.error) {
          return release.pipe(
            Effect.andThen(
              Deferred.fail(
                pendingEntry.deferred,
                new VisibleBrowserControlError({ message: input.error }),
              ),
            ),
          );
        }
        if (!input.result) {
          return release.pipe(
            Effect.andThen(
              Deferred.fail(
                pendingEntry.deferred,
                new VisibleBrowserControlError({
                  message: "Visible browser command returned no result.",
                }),
              ),
            ),
          );
        }
        return release.pipe(
          Effect.andThen(
            Deferred.succeed(pendingEntry.deferred, {
              ...input.result,
              target: "visible",
              leaseId: pendingEntry.command.leaseId,
            }),
          ),
        );
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

  const retention = makeVisibleBrowserRetentionControl({
    state,
    commands,
    releaseDurableLease,
  });

  return {
    hasThreadLease,
    isAvailable,
    execute,
    complete,
    streamCommands,
    ...retention,
  } satisfies VisibleBrowserControlShape;
});

export const VisibleBrowserControlLive = Layer.effect(
  VisibleBrowserControl,
  makeVisibleBrowserControl(),
);
