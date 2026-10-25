import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import path from "node:path";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { withV2FileRepositories } from "./SharedService.persistence.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeOwnedClient } from "./Client.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;
if (process.env.BIGBUD_OPENCODE_V2_REQUIRED_NATIVE === "1" && (!binary || !version))
  throw new Error("Required negative native history fixture unavailable.");

for (const history of ["missing", "wrong-owner"] as const) {
  it.skipIf(!binary || !version)(
    `real disposable native ${history} history rejects API-aware file-backed restart without create/prompt/resend or local evidence mutation`,
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
      let creates = 0,
        prompts = 0;
      const observed = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        if (init?.method === "POST" && url.pathname === "/api/session") creates++;
        if (url.pathname.endsWith("/prompt")) prompts++;
        return fetch(request, init);
      });
      const input = {
        threadId: ThreadId.makeUnsafe(`native-negative-${history}`),
        cwd: fixture.workspace,
        runtimeMode: "approval-required" as const,
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "bigbud-v2-fixture",
          model: "synthetic-model",
        },
      };
      const filename = path.join(fixture.workspace, "bigbud-api-history.sqlite");
      const createRuntime = async (
        repositories: Parameters<Parameters<typeof withV2FileRepositories>[1]>[0],
      ) => {
        const config = await readV2SharedApplicationConfig(
          { serviceFile: fixture.file },
          fixture.workspace,
        );
        return new OpencodeV2Runtime({
          ...repositories,
          config: config.process,
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
              if (!process.sharedService) throw new Error("Fixture borrows only.");
              return borrowV2SharedService(process.sharedService);
            },
          }),
        });
      };
      try {
        const original = await withV2FileRepositories(filename, async (repositories) => {
          const first = await createRuntime(repositories);
          try {
            const saved = await first.start(input);
            await first.send({
              threadId: input.threadId,
              requestMessageId: MessageId.makeUnsafe("negative-native-turn"),
              input: "Synthetic qualification only",
            });
            await expect
              .poll(() => first.get(input.threadId).terminalDelivered, { timeout: 15000 })
              .toBe(true);
            return {
              cursor: saved.resumeCursor,
              binding: JSON.stringify(
                await Effect.runPromise(repositories.sharedBindings.find(input.threadId)),
              ),
              journal: JSON.stringify(
                await Effect.runPromise(repositories.journal.latestBound(input.threadId)),
              ),
            };
          } finally {
            await first.close();
          }
        });
        if (history === "missing") await fixture.restart("empty");
        else {
          const registration = await readV2SharedRegistration(fixture.file);
          const client = makeOwnedClient({
            endpoint: registration.endpoint.url,
            password: registration.endpoint.auth!.password,
          });
          const id = (original.cursor as { nativeSessionId: string }).nativeSessionId;
          const native = await client.session.get({ sessionID: id });
          await client.session.update({
            sessionID: id,
            metadata: { ...native.metadata, bigbud_thread: "different-thread-owner" },
          });
        }
        const counts = { creates, prompts };
        await withV2FileRepositories(filename, async (repositories) => {
          const restarted = await createRuntime(repositories);
          try {
            await expect(
              restarted.start({ ...input, resumeCursor: original.cursor }),
            ).rejects.toThrow(
              history === "missing"
                ? "retained creation/admission intent"
                : "native session ownership rejected",
            );
            expect(
              JSON.stringify(
                await Effect.runPromise(repositories.sharedBindings.find(input.threadId)),
              ),
            ).toBe(original.binding);
            expect(
              JSON.stringify(
                await Effect.runPromise(repositories.journal.latestBound(input.threadId)),
              ),
            ).toBe(original.journal);
            expect({ creates, prompts }).toEqual(counts);
          } finally {
            await restarted.close();
          }
        });
        expect(creates).toBe(1);
        expect(prompts).toBe(1);
      } finally {
        observed.mockRestore();
        consent.close();
        await fixture.close();
      }
    },
    90000,
  );
}
