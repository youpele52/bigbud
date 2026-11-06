import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeOrganizationBridge } from "../../thread-organization/organizationBridge.ts";
import { runOrganizationLifecycle } from "../../thread-organization/organizationLifecycle.ts";
import { setOrganizationStatus } from "../../thread-organization/organizationStatus.ts";
import { awaitOrganizationRecovery } from "../../thread-organization/organizationRecovery.ts";
import {
  ThreadOrganizationReactor,
  type ThreadOrganizationReactorShape,
} from "../Services/ThreadOrganizationReactor.ts";

/** One server-scoped native scheduling owner. Repeated starts are idempotent.
 * Native failures pause automation; manual commands do not wait for recovery.
 */
const makeThreadOrganizationReactor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bridge = yield* makeOrganizationBridge;
  const settings = yield* ServerSettingsService;
  const started = yield* Ref.make(false);
  const start: ThreadOrganizationReactorShape["start"] = Effect.fn(
    "ThreadOrganizationReactor.start",
  )(function* () {
    if (!(yield* Ref.modify(started, (value) => [!value, true]))) return;
    yield* Effect.forkScoped(
      runOrganizationLifecycle({
        run: bridge.run(),
        status: (status, reason) => setOrganizationStatus(sql, status, reason),
        // A fresh subscription per pause: the next settings save or manual move is a retry.
        retry: Effect.raceFirst(
          Stream.runDrain(Stream.take(settings.streamChanges, 1)),
          awaitOrganizationRecovery(sql),
        ),
        // A terminal limit (too many threads, capture too slow) retries on a settings save only.
        explicitRetry: Stream.runDrain(Stream.take(settings.streamChanges, 1)),
      }),
    );
  });
  return { start } satisfies ThreadOrganizationReactorShape;
});
export const ThreadOrganizationReactorLive = Layer.effect(
  ThreadOrganizationReactor,
  makeThreadOrganizationReactor,
);
