import { Effect, Layer } from "effect";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";

type V2ManagerLimits = Partial<
  Pick<
    ConstructorParameters<typeof OpencodeV2ServerManager>[0],
    "maxOwners" | "maxQueuedEvents" | "maxEventBytes" | "consumerTimeoutMs"
  >
>;

/** In-memory admissions and shared bindings, as production composes them for the shared path. */
export const v2SharedNativePersistence = Layer.merge(
  ProviderTurnAdmissionsLive,
  OpencodeV2SharedBindingsLive,
).pipe(Layer.provide(SqlitePersistenceMemory));

/** Runtime-level native tests on the production shared path: host-user trust consent and a manager
 * that only borrows the fixture's registered service. It never launches a private process; the
 * native child is obtained exclusively through the approval-gated `sharedServiceNativeFixture`. */
export async function makeV2SharedNativeRuntimeHarness(fixture: {
  readonly file: string;
  readonly workspace: string;
}) {
  const settings = await Effect.runPromise(
    makeTestSettings({
      providers: {
        opencodeV2: {
          enabled: true,
          connectionMode: "shared",
          serviceFile: fixture.file,
          nativeServiceTrust: "host-user-v1",
        },
      },
    }),
  );
  const consent = new V2ConsentAuthority(settings);
  return {
    consent,
    /** Read per runtime: a fixture restart publishes a new generation that must be rebound. */
    async runtimeOptions(limits: V2ManagerLimits = {}) {
      const shared = await readV2SharedApplicationConfig(
        { serviceFile: fixture.file },
        fixture.workspace,
      );
      const manager = new OpencodeV2ServerManager({
        maxProcesses: 1,
        maxOwners: 25,
        maxQueuedEvents: 128,
        maxEventBytes: 2_000_000,
        consumerTimeoutMs: 15_000,
        ...limits,
        consent,
        start: (process) => {
          if (!process.sharedService) throw new Error("Shared native fixture only borrows.");
          return borrowV2SharedService(process.sharedService);
        },
      });
      return { config: shared.process, consent, manager };
    },
    close: () => consent.close(),
  };
}
