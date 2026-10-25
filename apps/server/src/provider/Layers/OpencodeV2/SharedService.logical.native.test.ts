import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts";
import {
  OpencodeV2SharedBindings,
  OpencodeV2SharedBindingsShape,
} from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;
if (process.env.BIGBUD_OPENCODE_V2_REQUIRED_NATIVE === "1" && (!binary || !version))
  throw new Error("Required logical native fixture missing.");

it.skipIf(!binary || !version)(
  "copied native DB preserves logical history and exact replay without physical admission or prompt/create replay",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!);
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
    const fetch = globalThis.fetch;
    let prompts = 0,
      creates = 0;
    const observed = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (init?.method === "POST" && url.pathname === "/api/session") creates++;
      if (url.pathname.endsWith("/prompt")) prompts++;
      return fetch(request, init);
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const sharedBindings = yield* OpencodeV2SharedBindings;
          const makeRuntime = async (bindings: OpencodeV2SharedBindingsShape) => {
            const config = await readV2SharedApplicationConfig(
              { serviceFile: fixture.file },
              fixture.workspace,
            );
            return new OpencodeV2Runtime({
              config: config.process,
              journal,
              sharedBindings: bindings,
              consent,
              allowLocalWorkspace: true,
              emit: async () => {},
              manager: new OpencodeV2ServerManager({
                maxProcesses: 1,
                maxOwners: 25,
                maxQueuedEvents: 128,
                maxEventBytes: 1000000,
                consumerTimeoutMs: 10000,
                consent,
                start: (process) => {
                  if (!process.sharedService) throw new Error("Fixture only borrows.");
                  return borrowV2SharedService(process.sharedService);
                },
              }),
            });
          };
          const input = {
            threadId: ThreadId.makeUnsafe("copied-logical-native"),
            cwd: fixture.workspace,
            runtimeMode: "approval-required" as const,
            modelSelection: {
              provider: "opencodeV2" as const,
              subProviderID: "bigbud-v2-fixture",
              model: "synthetic-model",
            },
          };
          const turn = {
            threadId: input.threadId,
            requestMessageId: MessageId.makeUnsafe("copy-replay"),
            input: "Synthetic logical copy",
          };
          const first = yield* Effect.promise(() => makeRuntime(sharedBindings));
          const saved = yield* Effect.promise(() => first.start(input));
          yield* Effect.promise(() => first.send(turn));
          yield* Effect.promise(() =>
            expect
              .poll(() => first.get(input.threadId).terminalDelivered, { timeout: 15000 })
              .toBe(true),
          );
          const row = yield* journal.latestBound(input.threadId);
          const binding = yield* sharedBindings.find(input.threadId);
          yield* Effect.promise(() => first.close());
          yield* Effect.promise(() => fixture.restart(true)); // Fixture-owned process and DB only.
          const second = yield* Effect.promise(() => makeRuntime(sharedBindings));
          try {
            const resumed = yield* Effect.promise(() =>
              second.start({ ...input, resumeCursor: saved.resumeCursor }),
            );
            expect(resumed.resumeCursor).toEqual(saved.resumeCursor);
            yield* Effect.promise(() => second.send(turn));
            expect(yield* journal.latestBound(input.threadId)).toEqual(row);
            expect(yield* sharedBindings.find(input.threadId)).toEqual(binding);
            expect(creates).toBe(1);
            expect(prompts).toBe(1);
          } finally {
            yield* Effect.promise(() => second.close());
          }
        }).pipe(
          Effect.provide(
            Layer.merge(ProviderTurnAdmissionsLive, OpencodeV2SharedBindingsLive).pipe(
              Layer.provide(SqlitePersistenceMemory),
            ),
          ),
        ),
      );
    } finally {
      observed.mockRestore();
      consent.close();
      await fixture.close();
    }
  },
  60000,
);
