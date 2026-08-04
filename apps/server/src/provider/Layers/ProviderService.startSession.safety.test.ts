import { assert } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderValidationError } from "../Errors.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const safety = makeProviderServiceLayer();

safety.layer("ProviderServiceLive start-session safety", (it) => {
  it.effect("rejects contradictory providers before adapter or persistence side effects", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-provider-mismatch");
      const priorCodexStarts = safety.codex.startSession.mock.calls.length;
      const priorCliProxyStarts = safety.cliProxy.startSession.mock.calls.length;

      const result = yield* provider
        .startSession(threadId, {
          provider: "codex",
          threadId,
          modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Provider 'codex' does not match modelSelection provider 'cliProxy'.",
        }),
      );
      assert.equal(safety.codex.startSession.mock.calls.length, priorCodexStarts);
      assert.equal(safety.cliProxy.startSession.mock.calls.length, priorCliProxyStarts);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );

  it.effect("loses durable admission races before starting an adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-provider-admission-race");
      const priorStarts = safety.codex.startSession.mock.calls.length;
      yield* sql`
        INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
        VALUES ('provider-admission-project', 'Project', '{}', datetime('now'), datetime('now'))
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, deleting_at, created_at, updated_at
        ) VALUES (${threadId}, 'provider-admission-project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          datetime('now'), datetime('now'), datetime('now'))
      `;

      const result = yield* provider
        .startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(safety.codex.startSession.mock.calls.length, priorStarts);
    }),
  );

  it.effect("stops the adapter and releases admission when final persistence loses a race", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-provider-final-persistence-race");
      yield* sql`
        INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
        VALUES ('provider-final-project', 'Project', '{}', datetime('now'), datetime('now'))
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (${threadId}, 'provider-final-project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          datetime('now'), datetime('now'))
      `;
      const start = safety.codex.startSession.getMockImplementation();
      if (!start) return yield* Effect.die("missing start implementation");
      safety.codex.startSession.mockImplementationOnce((startInput) =>
        start(startInput).pipe(
          Effect.tap(() =>
            sql`UPDATE projection_threads SET deleting_at = datetime('now')
                WHERE thread_id = ${threadId}`.pipe(Effect.orDie),
          ),
        ),
      );
      const priorStops = safety.codex.stopSession.mock.calls.length;

      const exit = yield* Effect.exit(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        }),
      );

      assert.equal(exit._tag, "Failure");
      assert.equal(safety.codex.stopSession.mock.calls.length, priorStops + 1);
      assert.isFalse(yield* safety.codex.hasSession(threadId));
      assert.isTrue(Option.isNone(yield* directory.getBinding(threadId)));
    }),
  );
});
