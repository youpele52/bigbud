import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { makeOrganizationProposalHandler } from "./organizationBridge.proposals.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { makeOrganizationOwnerFacts } from "./organizationFacts.owners.ts";
import { installOrganizationOwner } from "./organizationOwner.ts";
import type { OrganizationFrame, OrganizationProposal } from "./organizationProtocol.ts";

/** R1: a quiet `stale` (here: settings saved, policy frame not yet delivered) must not make the
 * next attempt reuse its identity. The real ledger refuses a reused identity with a different
 * creation time (fail-closed stays), and accepts the distinct attempt-0 identity Rust now mints.
 */
it(
  "a stale re-proposal with a fresh attempt identity is prepared by the real ledger, a reused one is refused",
  () =>
    withDatabase("inyosira-proposal-ledger-", async (path) => {
      const runtime = createRuntime(path);
      try {
        const engine = await engineFor(runtime);
        const threadId = ThreadId.makeUnsafe("ledger-identity-thread");
        for (const command of createCommands(ProjectId.makeUnsafe("ledger-identity-project"), [
          threadId,
        ]))
          await runtime.runPromise(engine.dispatch(command));
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const owners = yield* makeOrganizationOwnerFacts;
            const store = makeOrganizationFactStore({ sql, owners, now: Date.now });
            const observed = yield* store.observe(threadId, 300000);
            if (!observed.row) return yield* Effect.die("missing facts");
            // The owner still runs the previous policy fingerprint: every verdict is `stale`.
            installOrganizationOwner(sql, {
              backendNonce: "ledger-test",
              generation: 1,
              active: true,
              observedAtMs: Date.now(),
              policy: {
                version: 1,
                fingerprint: "previous-settings",
                scheduling: {
                  idleEnabled: false,
                  idleTimeoutMs: 600000,
                  idleDestination: 3,
                  olderEnabled: false,
                  olderTimeoutMs: 86400000,
                  graceMs: 300000,
                },
              },
              idleNotBeforeMs: 0,
              rows: new Map([[threadId, observed.row]]),
            });
            const operations = yield* makeThreadOrganizationOperations;
            const sent: OrganizationFrame[] = [];
            const handle = makeOrganizationProposalHandler({
              epoch: { backendNonce: "ledger-test", generation: 1 },
              engine,
              operations,
              refresh: () => Effect.void,
              send: (frame) => Effect.sync(() => void sent.push(frame)),
            });
            const proposal = (id: string, createdAtMs: number): OrganizationProposal => ({
              operationId: `operation-${id}`,
              occurrenceId: `occurrence-${id}`,
              attempt: 0,
              threadId,
              factVersion: observed.row!.factVersion,
              expectedRevision: 0,
              policyVersion: 1,
              from: 2,
              destination: 3,
              reason: 5,
              snoozeIdentity: "",
              createdAtMs,
            });
            const first = proposal("first", Date.now());
            yield* handle(first);
            const reused = yield* Effect.flip(handle({ ...first, createdAtMs: Date.now() + 1500 }));
            yield* handle(proposal("second", Date.now() + 1500));
            return {
              sent,
              reused: reused.message,
              first: yield* operations.read(first.operationId),
              second: yield* operations.read("operation-second"),
              pending: yield* sql<{
                count: number;
              }>`SELECT COUNT(*) AS count FROM thread_organization_operations WHERE status = 'prepared'`,
            };
          }),
        );
        expect(result.first?.outcome).toEqual({ status: "stale" });
        expect(result.reused).toMatch(/refused preparation/);
        expect(result.second?.outcome).toEqual({ status: "stale" });
        expect(
          result.sent.map((frame) => (frame.type === "receipt" ? frame.value.operationId : null)),
        ).toEqual(["operation-first", "operation-second"]);
        expect(result.pending).toEqual([{ count: 0 }]);
      } finally {
        await runtime.dispose();
      }
    }),
  30000,
);
