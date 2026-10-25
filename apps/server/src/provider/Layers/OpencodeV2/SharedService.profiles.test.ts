import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { isV2CompactNativeSessionId } from "./Orchestration.sessionIdentity.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("two independent profiles retain distinct sessions for the same thread and Location on one service across restart", async () => {
  await withV2RuntimeFixture(async (a) =>
    withV2RuntimeFixture(async (b) => {
      const input = {
        threadId: ThreadId.makeUnsafe("same-thread"),
        cwd: a.directory,
        runtimeMode: "approval-required" as const,
        modelSelection,
      };
      const optionsA = {
        ...sharedV2FixtureOptions(a.runtime, a.http),
        profileIssuer: async () => "a".repeat(64),
      };
      const optionsB = {
        ...sharedV2FixtureOptions(b.runtime, a.http),
        profileIssuer: async () => "b".repeat(64),
      };
      const ra = new OpencodeV2Runtime(optionsA),
        rb = new OpencodeV2Runtime(optionsB);
      try {
        await Promise.all([ra.start(input), rb.start(input)]);
        const na = ra.get(input.threadId).native,
          nb = rb.get(input.threadId).native;
        expect(na.id).not.toBe(nb.id);
        expect(isV2CompactNativeSessionId(na.id, "a".repeat(64))).toBe(true);
        expect(isV2CompactNativeSessionId(nb.id, "b".repeat(64))).toBe(true);
        expect(na.id.length).toBeLessThanOrEqual(100);
        expect(na.metadata?.bigbud_issuer).toBe("a".repeat(64));
        expect(nb.metadata?.bigbud_issuer).toBe("b".repeat(64));
        expect(a.http.sessions.size).toBe(2);
        const savedA = await Effect.runPromise(optionsA.sharedBindings!.find(input.threadId));
        expect(savedA).toMatchObject({
          identityKind: "shared-api-v2",
          registrationFamily: "scoped",
          profileIssuer: "a".repeat(64),
          state: "verified",
        });
        await ra.close();
        const restarted = new OpencodeV2Runtime({
          ...optionsA,
          manager: sharedV2FixtureOptions(a.runtime, a.http).manager,
        });
        try {
          await restarted.start(input);
          expect(restarted.get(input.threadId).native.id).toBe(na.id);
          expect(a.http.sessions.size).toBe(2);
        } finally {
          await restarted.close();
        }
        const foreign = new OpencodeV2Runtime({
          ...optionsA,
          profileIssuer: optionsB.profileIssuer,
        });
        try {
          await expect(foreign.start(input)).rejects.toThrow("issuer/family conflicts");
        } finally {
          await foreign.close();
        }
      } finally {
        await Promise.all([ra.close(), rb.close()]);
      }
    }),
  );
});

it("scoped lost-ack creation retains scheme/issuer and never recreates missing history", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const options = {
      ...sharedV2FixtureOptions(runtime, http),
      profileIssuer: async () => "c".repeat(64),
    };
    const input = {
      threadId: ThreadId.makeUnsafe("lost-scoped-create"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection,
    };
    const first = new OpencodeV2Runtime(options);
    http.loseCreateAck = true;
    try {
      await expect(first.start(input)).rejects.toThrow();
      const row = await Effect.runPromise(options.sharedBindings!.find(input.threadId));
      expect(row).toMatchObject({
        identityKind: "shared-api-v2",
        registrationFamily: "scoped",
        profileIssuer: "c".repeat(64),
        state: "dispatch-intent",
      });
      http.sessions.clear();
      http.loseCreateAck = false;
      const restarted = new OpencodeV2Runtime({
        ...options,
        manager: sharedV2FixtureOptions(runtime, http).manager,
      });
      try {
        await expect(restarted.start(input)).rejects.toThrow("no replacement");
      } finally {
        await restarted.close();
      }
      expect(await Effect.runPromise(options.sharedBindings!.find(input.threadId))).toEqual(row);
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(1);
    } finally {
      await expect(first.close()).rejects.toThrow("unconfirmed"); // Uncertain native mutation must stay quarantined.
    }
  });
});
