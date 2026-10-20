import { Effect } from "effect";
import { realpath } from "node:fs/promises";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2BoundedRouterFixture } from "./Runtime.router.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { v2Request } from "./Client.ts";
import {
  v2ScopedNativeSessionPrefix,
  v2CompactNativeSessionId,
} from "./Orchestration.sessionIdentity.ts";

const issuer = "a".repeat(64);
const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("actual HTTP create bodies accept historical IDs that path routing rejects; compact exact GET succeeds", async () => {
  await withV2RuntimeFixture(async ({ http, directory }) => {
    const router = await makeV2BoundedRouterFixture(http);
    try {
      const old = `${v2ScopedNativeSessionPrefix(issuer)}${"b".repeat(64)}`;
      for (const id of [
        "x".repeat(99),
        "x".repeat(100),
        "x".repeat(101),
        old,
        v2CompactNativeSessionId(issuer, "b".repeat(64)),
      ]) {
        await router.client.session.create({ id, location: { directory } });
        expect(http.sessions.has(id)).toBe(true);
        if (id.length <= 100)
          expect((await router.client.session.get({ sessionID: id })).id).toBe(id);
        else
          await expect(
            v2Request("startup session.verify", (signal) =>
              router.client.session.get({ sessionID: id }, { signal }),
            ),
          ).rejects.toThrow("startup session.verify returned HTTP 404");
      }
    } finally {
      await router.close();
    }
  });
});

it.each([false, true])(
  "production startup over bounded HTTP preserves create/verify evidence (verify failure=%s)",
  async (fail) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const router = await makeV2BoundedRouterFixture(http);
      const options = {
        ...sharedV2FixtureOptions(runtime, router),
        profileIssuer: async () => issuer,
      };
      const input = {
        threadId: ThreadId.makeUnsafe("bounded-start"),
        cwd: directory,
        runtimeMode: "approval-required" as const,
        modelSelection,
      };
      const first = new OpencodeV2Runtime(options);
      http.failSessionVerification = fail;
      try {
        if (fail)
          await expect(first.start(input)).rejects.toThrow(
            "startup session.verify returned HTTP 404",
          );
        else await first.start(input);
        const row = await Effect.runPromise(options.sharedBindings!.find(input.threadId));
        expect(row).toMatchObject({
          state: fail ? "dispatch-intent" : "verified",
          identityKind: "shared-api-v2",
          profileIssuer: issuer,
        });
        expect(row!.nativeSessionId).toHaveLength(95);
        expect(http.sessions.has(row!.nativeSessionId)).toBe(true);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
        if (fail) {
          const restarted = new OpencodeV2Runtime({
            ...options,
            manager: sharedV2FixtureOptions(runtime, router).manager,
          });
          try {
            await expect(restarted.start(input)).rejects.toThrow();
          } finally {
            await restarted.close();
          }
          expect(await Effect.runPromise(options.sharedBindings!.find(input.threadId))).toEqual(
            row,
          );
        }
        expect(
          http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
        ).toHaveLength(1);
      } finally {
        if (fail) await expect(first.close()).rejects.toThrow("unconfirmed");
        else await first.close();
        await router.close();
      }
    });
  },
);

it("retained overlong dispatch intent is never rederived, fetched, recreated or replayed", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const options = { ...sharedV2FixtureOptions(runtime, http), profileIssuer: async () => issuer };
    const threadId = ThreadId.makeUnsafe("retained-overlong");
    const reserved = await Effect.runPromise(
      options.sharedBindings!.reserve({
        threadId,
        nativeSessionId: `${v2ScopedNativeSessionPrefix(issuer)}${"b".repeat(64)}`,
        directory: await realpath(directory),
        storageIdentity: "logical-shared-seed",
        runtimeTargetId: "local",
        workspaceTargetId: "local",
        identityKind: "shared-api-v2",
        profileIssuer: issuer,
        registrationFamily: "scoped",
        material: "retained-material",
      }),
    );
    const retained = await Effect.runPromise(
      options.sharedBindings!.transition(reserved, "dispatch-intent"),
    );
    await http.client.session.create({ id: retained.nativeSessionId, location: { directory } });
    const native = http.sessions.get(retained.nativeSessionId);
    http.calls.length = 0;
    const next = new OpencodeV2Runtime(options);
    try {
      await expect(
        next.start({ threadId, cwd: directory, runtimeMode: "approval-required", modelSelection }),
      ).rejects.toThrow("use an explicit new thread");
      expect(await Effect.runPromise(options.sharedBindings!.find(threadId))).toEqual(retained);
      expect(http.calls).toHaveLength(0);
      expect(http.sessions.size).toBe(1);
      expect(http.sessions.get(retained.nativeSessionId)).toBe(native);
    } finally {
      await next.close();
    }
  });
});
