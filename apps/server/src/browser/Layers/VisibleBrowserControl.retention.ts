import type { VisibleBrowserCommand, VisibleBrowserLeaseSnapshot } from "@bigbud/contracts";
import { Deferred, Effect, PubSub, Ref } from "effect";

import {
  VisibleBrowserControlError,
  type VisibleBrowserControlShape,
} from "../Services/VisibleBrowserControl.ts";
import {
  type Lease,
  type PendingCommand,
  type ReleasedLeases,
  type VisibleBrowserState as State,
} from "./VisibleBrowserControl.state.ts";

export function makeVisibleBrowserRetentionControl(input: {
  readonly state: Ref.Ref<State>;
  readonly commands: PubSub.PubSub<VisibleBrowserCommand>;
  readonly releaseDurableLease: (leaseId: string) => Effect.Effect<void>;
}) {
  const reconcileThread: VisibleBrowserControlShape["reconcileThread"] = (request) =>
    Ref.modify(input.state, (current): readonly [ReleasedLeases, State] => {
      const releasedLeaseIds = new Set<string>();
      for (const lease of current.leases.values()) {
        if (
          lease.threadId === request.threadId &&
          (!request.isRunning || lease.turnId !== request.activeTurnId)
        ) {
          releasedLeaseIds.add(lease.leaseId);
        }
      }
      const leases = new Map(current.leases);
      const releasedLeases: Lease[] = [];
      for (const leaseId of releasedLeaseIds) {
        const lease = leases.get(leaseId);
        if (lease) releasedLeases.push(lease);
        leases.delete(leaseId);
      }
      const pending = new Map(current.pending);
      const releases = new Map(current.releases);
      const revokedTabs = new Map(current.revokedTabs);
      const createdTabs = new Map(current.createdTabs);
      for (const [tabId, revoked] of revokedTabs) {
        if (
          revoked.threadId === request.threadId &&
          (!request.isRunning || revoked.turnId !== request.activeTurnId)
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
      for (const command of releasedCommands) releases.set(command.commandId, command);
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
          yield* Effect.forEach(
            released.releases,
            (command) => PubSub.publish(input.commands, command),
            { discard: true },
          );
          yield* Effect.forEach(
            released.leases,
            (lease) => input.releaseDurableLease(lease.leaseId),
            { discard: true },
          );
        }),
      ),
      Effect.asVoid,
    );

  const revokeLease: VisibleBrowserControlShape["revokeLease"] = (request) =>
    Ref.modify(
      input.state,
      (
        current,
      ): readonly [
        { readonly pending: ReadonlyArray<PendingCommand>; readonly released: boolean },
        State,
      ] => {
        const lease = current.leases.get(request.leaseId);
        if (!lease || lease.rendererId !== request.rendererId || lease.tabId !== request.tabId) {
          return [{ pending: [], released: false }, current] as const;
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
          if (command.leaseId === lease.leaseId) releases.delete(commandId);
        }
        const revokedTabs = new Map(current.revokedTabs);
        revokedTabs.set(request.tabId, { threadId: lease.threadId, turnId: lease.turnId });
        const createdTabs = new Map(current.createdTabs);
        createdTabs.delete(request.tabId);
        return [
          { pending: revokedPending, released: true },
          { ...current, leases, pending, releases, revokedTabs, createdTabs },
        ] as const;
      },
    ).pipe(
      Effect.flatMap((revoked) =>
        Effect.all(
          [
            Effect.forEach(
              revoked.pending,
              (entry) =>
                Deferred.fail(
                  entry.deferred,
                  new VisibleBrowserControlError({ message: "Browser lease revoked by user." }),
                ),
              { discard: true },
            ),
            revoked.released ? input.releaseDurableLease(request.leaseId) : Effect.void,
          ],
          { discard: true },
        ),
      ),
      Effect.asVoid,
    );

  const getLeases: VisibleBrowserControlShape["getLeases"] = (rendererId) =>
    Ref.get(input.state).pipe(
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

  return { reconcileThread, revokeLease, getLeases };
}
