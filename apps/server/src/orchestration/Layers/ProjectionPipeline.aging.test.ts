import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionPipelinePrefixedTestLayer } from "./ProjectionPipeline.test.helpers.ts";
import { makeSetThreadOrganization } from "../../persistence/Layers/ProjectionThreads.organization.ts";
import { makeListIdleThreadCandidates } from "../../persistence/Layers/ProjectionThreads.idle.ts";
import { parseBaselinePayload } from "../../persistence/Layers/ProjectionBaselines.payload.ts";
import {
  captureBaselinePayloadJson,
  jsonBaselinePayloadSource,
} from "../../persistence/Layers/ProjectionBaselines.test.helpers.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-aging-test-")));
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-11-05T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("aging-project");
const threadId = ThreadId.makeUnsafe("aging-thread");

layer("source-aware aging replay", (it) => {
  it.effect(
    "automatic Later keeps inactivity age through verified compaction, restore and suffix replay",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const baselines = yield* ProjectionBaselineRepository;
        const base = (
          id: string,
          kind: "project" | "thread",
          aggregateId: ProjectId | ThreadId,
          at = OLD,
        ) => ({
          eventId: EventId.makeUnsafe(id),
          aggregateKind: kind,
          aggregateId,
          occurredAt: at,
          commandId: CommandId.makeUnsafe(id),
          causationEventId: null,
          correlationId: null,
          metadata: {},
        });
        yield* store.append({
          ...base("aging-project-create", "project", projectId),
          type: "project.created",
          payload: {
            projectId,
            title: "Aging",
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: OLD,
            updatedAt: OLD,
          },
        });
        yield* store.append({
          ...base("aging-thread-create", "thread", threadId),
          type: "thread.created",
          payload: {
            threadId,
            projectId,
            title: "Aging",
            modelSelection: { provider: "codex", model: "fixture" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: OLD,
            updatedAt: OLD,
          },
        });
        yield* store.append({
          ...base("aging-deliberate", "thread", threadId),
          type: "thread.organization-updated",
          payload: {
            threadId,
            reason: "move",
            source: "deliberate",
            organization: {
              state: "present",
              revision: 1,
              changedAt: OLD,
              snooze: null,
            },
          },
        });
        yield* store.append({
          ...base("aging-idle", "thread", threadId, RECENT),
          type: "thread.organization-updated",
          payload: {
            threadId,
            reason: "idle",
            source: "automatic",
            organization: {
              state: "later",
              revision: 2,
              changedAt: RECENT,
              snooze: null,
            },
          },
        });
        yield* pipeline.bootstrap;
        const before = yield* sql`SELECT organization_revision, organization_changed_at,
      organization_activity_at, organization_age_provenance FROM projection_threads WHERE thread_id = ${threadId}`;
        assert.deepEqual(before, [
          {
            organization_revision: 2,
            organization_changed_at: RECENT,
            organization_activity_at: OLD,
            organization_age_provenance: "known",
          },
        ]);
        assert.equal(
          (yield* makeListIdleThreadCandidates(sql)({
            states: ["later"],
            cutoff: "2026-10-15T00:00:00.000Z",
            limit: 10,
          })).length,
          1,
        );
        // Authoritative runtime is deliberately not part of baseline restore/replay ownership.
        yield* sql`UPDATE thread_organization_runtime SET policy_version = 7, canonical_frontier = 4`;
        const runtime = yield* sql`SELECT * FROM thread_organization_runtime`;
        yield* pipeline.ensureVerifiedBaselineThrough(4);
        const verified = yield* baselines.latestVerified();
        assert.equal(verified._tag, "Some");
        yield* pipeline.compactVerifiedPrefix(100);
        assert.equal((yield* store.readReplay(0)).availability, "gap");
        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_state`;
        yield* pipeline.bootstrap;
        assert.deepEqual(
          yield* sql`SELECT organization_revision, organization_changed_at,
      organization_activity_at, organization_age_provenance FROM projection_threads WHERE thread_id = ${threadId}`,
          before,
        );
        assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime`, runtime);
        const snooze = { id: "aging-snooze", until: "2026-11-05T02:00:00.000Z" };
        const suffix = yield* store.append({
          ...base("aging-suffix", "thread", threadId, RECENT),
          type: "thread.organization-updated",
          payload: {
            threadId,
            reason: "snooze",
            source: "deliberate",
            organization: {
              state: "later",
              revision: 3,
              changedAt: RECENT,
              snooze,
            },
          },
        });
        yield* pipeline.projectEvent(suffix);
        yield* pipeline.ensureVerifiedBaselineThrough(5);
        yield* pipeline.compactVerifiedPrefix(100);
        yield* sql`DELETE FROM projection_state`;
        yield* pipeline.bootstrap;
        assert.deepEqual(
          yield* sql`SELECT organization_activity_at, organization_snooze_id,
      organization_snooze_until, organization_revision FROM projection_threads WHERE thread_id = ${threadId}`,
          [
            {
              organization_activity_at: RECENT,
              organization_snooze_id: snooze.id,
              organization_snooze_until: snooze.until,
              organization_revision: 3,
            },
          ],
        );
        assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime`, runtime);
      }),
  );

  it.effect("legacy baselines restore a recorded conservative anchor, never restore-time age", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const legacyId = ThreadId.makeUnsafe("legacy-aging-thread");
      yield* insertProjectionThreadParent({ sql, threadId: legacyId, createdAt: OLD });
      yield* makeSetThreadOrganization(sql)({
        threadId: legacyId,
        reason: "move",
        organization: {
          state: "later",
          revision: 1,
          changedAt: RECENT,
          snooze: null,
        },
      });
      const payload = parseBaselinePayload(yield* captureBaselinePayloadJson);
      // Remove post-migration fields as in an old baseline.
      const rows = payload.tables.projection_threads!.map((row) => {
        const {
          organization_activity_at: _anchor,
          organization_age_provenance: _provenance,
          ...legacy
        } = row;
        return legacy;
      });
      const legacy = JSON.stringify({ tables: { ...payload.tables, projection_threads: rows } });
      yield* baselines.restorePayload(jsonBaselinePayloadSource(legacy), 5, []);
      const [row] = yield* sql<{
        anchor: string;
        provenance: string;
      }>`SELECT organization_activity_at AS anchor,
      organization_age_provenance AS provenance FROM projection_threads WHERE thread_id = ${legacyId}`;
      assert.deepEqual(row, { anchor: RECENT, provenance: "fallback" });
      yield* makeSetThreadOrganization(sql)({
        threadId: legacyId,
        reason: "idle",
        source: "automatic",
        organization: {
          state: "done",
          revision: 4,
          changedAt: "2026-12-01T00:00:00.000Z",
          snooze: null,
        },
      });
      const [after] = yield* sql<{
        anchor: string;
      }>`SELECT organization_activity_at AS anchor FROM projection_threads WHERE thread_id = ${legacyId}`;
      assert.equal(after?.anchor, RECENT);
    }),
  );
});
