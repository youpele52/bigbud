import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  buildAppUnderTest,
  getWsServerUrl,
  makeDefaultOrchestrationReadModel,
  serverTestLayer,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withRetriedMobileWsRpcClient } from "./server.test.mobile.ts";

it.layer(serverTestLayer)("mobile scope before attachment normalization", (it) => {
  for (const type of ["thread.message.submit", "thread.turn.start", "thread.shell.run"] as const) {
    for (const scope of ["read-only", "approve-only", "thread-control"] as const) {
      for (const transport of ["base64", "path"] as const) {
        it.effect(
          `${scope}: ${type} ${transport} attachment side effects require authorization`,
          () =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const root = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-scope-" });
              const attachmentsDir = path.join(root, "attachments");
              const sourcePath = path.join(root, "private.txt");
              yield* fs.makeDirectory(attachmentsDir);
              yield* fs.writeFileString(sourcePath, "private content");
              let normalizationReads = 0;
              let dispatched = 0;
              yield* buildAppUnderTest({
                config: { attachmentsDir },
                layers: {
                  mobileRemoteControl: {
                    validateSessionToken: () =>
                      Effect.succeed({
                        sessionId: "attachment-scope",
                        token: "scope-token",
                        scope,
                        createdAt: "2026-11-14T00:00:00.000Z",
                        expiresAt: "2099-01-01T00:00:00.000Z",
                        lastUsedAt: null,
                        revokedAt: null,
                        label: "scope fixture",
                      }),
                  },
                  orchestrationEngine: {
                    ensureThreadState: () =>
                      Effect.sync(() => {
                        normalizationReads++;
                        return makeDefaultOrchestrationReadModel().threads[0]!;
                      }),
                  },
                  commandGateway: {
                    dispatchNormalized: () =>
                      Effect.sync(() => {
                        dispatched++;
                        return { sequence: 1 };
                      }),
                  },
                },
              });
              const wsUrl = yield* getWsServerUrl("/mobile-ws?token=scope-token");
              const result = yield* Effect.scoped(
                withRetriedMobileWsRpcClient(wsUrl, (client) =>
                  client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                    type,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    shellCommand: "echo hello",
                    commandId: `attachment-${scope}-${transport}`,
                    threadId: "thread-default",
                    message: {
                      messageId: "attachment-message",
                      role: "user",
                      text: "hello",
                      attachments: [
                        {
                          type: "file",
                          transport,
                          name: "private.txt",
                          mimeType: "text/plain",
                          sizeBytes: 15,
                          ...(transport === "path"
                            ? { filePath: sourcePath }
                            : {
                                dataUrl: "data:text/plain;base64,cHJpdmF0ZSBjb250ZW50",
                              }),
                        },
                      ],
                    },
                    delivery: "auto",
                    createdAt: "2026-11-14T00:00:00.000Z",
                  } as never),
                ).pipe(Effect.result),
              );
              const entries = yield* fs.readDirectory(attachmentsDir);
              if (scope === "thread-control" && type !== "thread.shell.run") {
                assert.equal(result._tag, "Success");
                assert.equal(dispatched, 1);
                assert.isAbove(normalizationReads, 0);
                assert.isAbove(entries.length, 0);
              } else {
                assert.equal(result._tag, "Failure");
                if (result._tag === "Failure")
                  assert.include(JSON.stringify(result.failure), "unauthorized");
                assert.equal(dispatched, 0);
                assert.equal(
                  normalizationReads,
                  0,
                  "denied commands must not enter attachment hydration",
                );
                assert.deepEqual(entries, [], "denied uploads must not persist attachments");
              }
            }).pipe(Effect.provide(serverHttpTestLayer)),
        );
      }
    }
  }
});
