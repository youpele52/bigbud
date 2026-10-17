import { Effect } from "effect";
import { expect, it } from "vitest";
import path from "node:path";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { withV2FileRepositories } from "./SharedService.persistence.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";

for (const history of ["survives", "missing"] as const) {
  it(`file-backed migrated SQLite closes/reopens an intent-only record: ${history} exact native history never creates or prompts twice`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const filename = path.join(directory, "bigbud.sqlite");
      const input = {
        threadId: ThreadId.makeUnsafe(`file-intent-${history}`),
        cwd: directory,
        runtimeMode: "approval-required" as const,
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      };
      const original = await withV2FileRepositories(filename, async (repositories) => {
        const first = new OpencodeV2Runtime({
          ...sharedV2FixtureOptions(runtime, http),
          ...repositories,
        });
        try {
          http.loseCreateAck = true;
          await expect(first.start(input)).rejects.toThrow();
          expect(
            await Effect.runPromise(repositories.journal.latestBound(input.threadId)),
          ).toBeUndefined();
          const row = await Effect.runPromise(repositories.sharedBindings.find(input.threadId));
          expect(row?.state).toBe("dispatch-intent");
          return JSON.stringify(row);
        } finally {
          await first.close().catch(() => {});
        }
      }); // Connection scope is closed before the second invocation.
      http.loseCreateAck = false;
      if (history === "missing") http.sessions.clear();
      await withV2FileRepositories(filename, async (repositories) => {
        expect(
          JSON.stringify(await Effect.runPromise(repositories.sharedBindings.find(input.threadId))),
        ).toBe(original);
        expect(
          await Effect.runPromise(repositories.journal.latestBound(input.threadId)),
        ).toBeUndefined();
        const second = new OpencodeV2Runtime({
          ...sharedV2FixtureOptions(runtime, http),
          ...repositories,
        });
        try {
          if (history === "missing") {
            await expect(second.start(input)).rejects.toThrow("retained creation/admission intent");
            expect(
              JSON.stringify(
                await Effect.runPromise(repositories.sharedBindings.find(input.threadId)),
              ),
            ).toBe(original);
          } else {
            const saved = await second.start(input);
            expect(saved.resumeCursor).toMatchObject({
              nativeSessionId: JSON.parse(original).nativeSessionId,
              storageIdentity: JSON.parse(original).storageIdentity,
            });
            const verified = await Effect.runPromise(
              repositories.sharedBindings.find(input.threadId),
            );
            expect(verified).toEqual({
              ...JSON.parse(original),
              state: "verified",
              revision: JSON.parse(original).revision + 1,
            });
          }
          expect(
            http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
          ).toHaveLength(1);
          expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
        } finally {
          await second.close();
        }
      });
    });
  });
}
