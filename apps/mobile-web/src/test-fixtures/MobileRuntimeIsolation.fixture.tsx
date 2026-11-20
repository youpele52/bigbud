import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useLayoutEffect, useMemo, useState } from "react";

import { MobileRuntimeBoundary } from "../context/MobileRuntimeBoundary";
import { MobileSessionContext, useMobileSessionState } from "../context/MobileSessionContext";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import {
  makeMobileComposerDraftIdentity,
  readMobileComposerDraft,
} from "../lib/mobileComposerDraft";
import { useMobileThreadState } from "../screens/MobileThread.state";
import { useMobileThreadDelivery } from "../screens/MobileThread.delivery";
import type { StoredMobileSession } from "../lib/mobileSession";

import { runtimeIsolationSessions } from "./MobileRuntimeIsolation.data";

interface Observation {
  readonly origin: string | null;
  readonly clientOrigin: string | null;
  readonly snapshotTitle: string | null;
  readonly delivery: string | null;
  readonly draft: string;
  readonly storedDraft: string | null;
  readonly storedCommandId: string | null;
}
export const runtimeIsolationObservations: Observation[] = [];
const clientOrigins = new WeakMap<object, string>();

function RuntimeProbe() {
  const { session, setSession } = useMobileSessionState();
  const { client, snapshotQuery, recoveryState } = useMobileSnapshot(session);
  if (client && session && !clientOrigins.has(client))
    clientOrigins.set(client, session.backendBaseUrl);
  const identity = useMemo(
    () =>
      session
        ? makeMobileComposerDraftIdentity({
            backendBaseUrl: session.backendBaseUrl,
            sessionId: session.sessionId,
            threadId: "fixture-thread",
          })
        : null,
    [session],
  );
  const composition = useMobileThreadState({
    identity,
    threadId: ThreadId.makeUnsafe("fixture-thread"),
  });
  const { delivery } = useMobileThreadDelivery({
    identity,
    threadId: "fixture-thread",
    freshness: recoveryState.freshness,
    submitted: composition.submitted,
    decisionSubmitted: composition.decisionSubmitted,
    onStateChange: composition.setDeliveryState,
    onDecisionStateChange: composition.setDecisionDeliveryState,
  });
  const stored = identity ? readMobileComposerDraft(identity).draft : null;
  const observation = {
    origin: session?.backendBaseUrl ?? null,
    clientOrigin: client ? (clientOrigins.get(client) ?? null) : null,
    snapshotTitle: snapshotQuery.data?.projects[0]?.title ?? null,
    delivery: composition.submitted?.status ?? null,
    draft: composition.prompt,
    storedDraft: stored?.prompt ?? null,
    storedCommandId: stored?.submitted?.command.commandId ?? null,
  };
  useLayoutEffect(() => {
    runtimeIsolationObservations.push(observation);
  });
  return (
    <main>
      <output data-runtime-observation="true">{JSON.stringify(observation)}</output>
      <textarea
        aria-label="Fixture draft"
        value={composition.prompt}
        onChange={(event) => composition.setPrompt(event.target.value)}
      />
      <button type="button" onClick={() => setSession(runtimeIsolationSessions[1] ?? null)}>
        Select fixture B
      </button>
      <button type="button" onClick={() => setSession(runtimeIsolationSessions[0] ?? null)}>
        Select fixture A
      </button>
      <button type="button" onClick={() => setSession(null)}>
        Forget fixture
      </button>
      <button
        type="button"
        disabled={!client}
        onClick={() => {
          if (!client) return;
          void delivery.submit({
            command: {
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe("held-runtime-command"),
              threadId: ThreadId.makeUnsafe("fixture-thread"),
              createdAt: new Date().toISOString(),
            },
            submittedRevision: 1,
            dispatch: (command) => client.dispatchCommand(command),
          });
        }}
      >
        Start held fixture command
      </button>
    </main>
  );
}

/** Actual production runtime boundary; disposable data and real connection/recovery hooks. */
export function MobileRuntimeIsolationFixture() {
  const [session, setSession] = useState<StoredMobileSession | null>(
    runtimeIsolationSessions[0] ?? null,
  );
  const state = useMemo(() => ({ session, setSession }), [session]);
  return (
    <MobileSessionContext.Provider value={state}>
      <MobileRuntimeBoundary session={session}>
        <RuntimeProbe />
      </MobileRuntimeBoundary>
    </MobileSessionContext.Provider>
  );
}
