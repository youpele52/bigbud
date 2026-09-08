import { ThreadId } from "@bigbud/contracts";
import { useEffect, useRef } from "react";

import { repairPersistedDraftOwnership } from "../hooks/draftOwnership.repair";
import { reconcilePersistedMaterializationAttempts } from "../hooks/materializationAttempts.reconcile";
import { readNativeApi } from "../rpc/nativeApi";
import {
  clearPromotedDraftThread,
  replaceCollidingDraftThreadLocally,
  type ProjectDraftThread,
  useComposerDraftStore,
} from "../stores/composer";
import { subscribeToMaterializationLedger } from "../stores/materialization/materializationLedger";
import { subscribeToOwnershipLedger } from "../stores/ownership/ownershipLedger";
import {
  initializeOwnershipFromComposer,
  reconcileComposerFromOwnershipLedger,
} from "../stores/ownership/ownershipLedger.reconcile";
import type { OwnershipScope } from "../stores/ownership/ownershipLedger.types";
import { useStore } from "../stores/main";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { getDraftOwnershipRepairConnection } from "./DraftOwnershipCoordinator.logic";
import {
  reconcilePersistedCommands,
  subscribeToPersistedCommandChanges,
} from "../lib/orchestrationCommandRecovery";

export function DraftOwnershipCoordinator({
  repairOnStartup,
  scope = "main",
}: {
  repairOnStartup: boolean;
  scope?: OwnershipScope;
}) {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const connection = useWsConnectionStatus();
  const { connectedAt, phase } = connection;
  const lastRepairConnectionRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const reconcile = () => {
      try {
        reconcileComposerFromOwnershipLedger(scope);
      } catch (error) {
        console.warn("[draft-ownership] Persisted ownership is unavailable.", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    };
    void initializeOwnershipFromComposer({ scope })
      .then(() => {
        if (!disposed) reconcile();
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.warn("[draft-ownership] Ownership initialization failed.", {
            reason: error instanceof Error ? error.name : "unknown",
          });
        }
      });
    const unsubscribe = subscribeToOwnershipLedger(() => reconcile());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [repairOnStartup, scope]);

  useEffect(() => {
    if (!bootstrapComplete || phase !== "connected") return;
    const api = readNativeApi();
    if (!api) return;
    let commandRunning = false;
    let materializationRunning = false;
    const reconcileCommands = () => {
      if (commandRunning) return;
      commandRunning = true;
      void reconcilePersistedCommands(api)
        .catch((error: unknown) => {
          console.warn("[orchestration-recovery] Command reconciliation failed.", {
            reason: error instanceof Error ? error.name : "unknown",
          });
        })
        .finally(() => {
          commandRunning = false;
        });
    };
    const reconcileMaterializations = () => {
      if (materializationRunning) return;
      materializationRunning = true;
      void reconcilePersistedMaterializationAttempts({
        api,
        callbacks: {
          reconcileCanonical: clearPromotedDraftThread,
          replaceCollision: replaceCollidingDraftThreadLocally,
        },
      }).finally(() => {
        materializationRunning = false;
      });
    };
    reconcileCommands();
    reconcileMaterializations();
    const unsubscribeCommands = subscribeToPersistedCommandChanges(() => reconcileCommands());
    const unsubscribeMaterializations = subscribeToMaterializationLedger(() =>
      reconcileMaterializations(),
    );
    return () => {
      unsubscribeCommands();
      unsubscribeMaterializations();
    };
  }, [bootstrapComplete, connectedAt, phase]);

  useEffect(() => {
    const repairConnection = getDraftOwnershipRepairConnection({
      bootstrapComplete,
      connection: { connectedAt, phase },
      lastRepairConnection: lastRepairConnectionRef.current,
      repairOnStartup,
    });
    if (!repairConnection || scope !== "main") return;
    const api = readNativeApi();
    if (!api) return;
    const drafts: ProjectDraftThread[] = [];
    for (const [threadId, draft] of Object.entries(
      useComposerDraftStore.getState().draftThreadsByThreadId,
    )) {
      drafts.push({ threadId: ThreadId.makeUnsafe(threadId), ...draft });
    }
    if (drafts.length === 0) return;

    let disposed = false;
    void repairPersistedDraftOwnership({
      api,
      drafts,
      reconcileCanonical: clearPromotedDraftThread,
      replaceCollision: replaceCollidingDraftThreadLocally,
    }).then((summary) => {
      if (disposed) return;
      lastRepairConnectionRef.current = repairConnection;
      if (summary.failures.length > 0) {
        console.warn("[draft-ownership] Reconciliation will retry after reconnect.", {
          failureCount: summary.failures.length,
          reasons: [...new Set(summary.failures.map((failure) => failure.reason))],
        });
      } else if (import.meta.env.MODE !== "test") {
        console.info("[draft-ownership] Startup reconciliation completed.", summary);
      }
    });
    return () => {
      disposed = true;
    };
  }, [bootstrapComplete, connectedAt, phase, repairOnStartup, scope]);

  return null;
}
