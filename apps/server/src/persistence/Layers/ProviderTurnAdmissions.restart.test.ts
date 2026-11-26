import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { layer as sqliteLayer } from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";

it("keeps uncertain intents and terminal anti-replay evidence after SQLite close/reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-journal-"));
  const filename = path.join(root, "fixture.sqlite");
  const input = {
    namespace: "learning" as const,
    ownerThreadId: ThreadId.makeUnsafe("owner"),
    requestMessageId: MessageId.makeUnsafe("job-message"),
    fingerprint: "digest",
    nativeAdmissionId: "msg_fixture",
    turnId: TurnId.makeUnsafe("canonical-turn"),
    createdAt: "2026-09-30T00:00:00.000Z",
    binding: {
      provider: "opencodeV2",
      threadId: ThreadId.makeUnsafe("isolated-review"),
      nativeSessionId: "ses_fixture",
      location: "/synthetic",
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      storageIdentity: "isolated",
    },
  };
  const repositoryLayer = () =>
    ProviderTurnAdmissionsLive.pipe(Layer.provide(sqliteLayer({ filename })));
  try {
    await Effect.runPromise(runMigrations().pipe(Effect.provide(sqliteLayer({ filename }))));
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const reserved = yield* journal.reserve(input);
        yield* journal.transition(reserved, "dispatch-intent", input.createdAt);
      }).pipe(Effect.provide(repositoryLayer())),
    );
    const reopened = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const row = yield* journal.find(input);
        expect(row?.state).toBe("dispatch-intent");
        const accepted = yield* journal.transition(row!, "accepted", input.createdAt);
        return yield* journal.transition(
          accepted,
          "terminal",
          input.createdAt,
          "validated later, not applied here",
          "completed",
        );
      }).pipe(Effect.provide(repositoryLayer())),
    );
    const repeated = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        return yield* journal.reserve(input);
      }).pipe(Effect.provide(repositoryLayer())),
    );
    expect(repeated).toEqual(reopened);
    expect(repeated.terminalOutcome).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["muse", "opencodeV2"] as const)(
  "reopens only the exact locally undispatched %s intent across SQLite restart",
  async (provider) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-local-refusal-"));
    const filename = path.join(root, "fixture.sqlite");
    const threadId = ThreadId.makeUnsafe("foreground");
    const input = {
      namespace: "foreground" as const,
      ownerThreadId: threadId,
      requestMessageId: MessageId.makeUnsafe("same-message"),
      fingerprint: "digest",
      nativeAdmissionId: "native-id",
      turnId: TurnId.makeUnsafe("canonical-turn"),
      createdAt: "2026-11-23T00:00:00.000Z",
      binding: {
        provider,
        threadId,
        nativeSessionId: "ses_fixture",
        location: "/synthetic",
        runtimeTargetId: "local",
        workspaceTargetId: "local",
        storageIdentity: "isolated",
      },
    };
    const repositoryLayer = () =>
      ProviderTurnAdmissionsLive.pipe(Layer.provide(sqliteLayer({ filename })));
    try {
      await Effect.runPromise(runMigrations().pipe(Effect.provide(sqliteLayer({ filename }))));
      const intent = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const row = yield* journal.reserve(input);
          const intent = yield* journal.transition(row, "dispatch-intent", input.createdAt);
          const reopened = yield* journal.reopenUndispatchedIntent!(intent, input.createdAt);
          expect(reopened).toMatchObject({
            state: "reserved",
            revision: 2,
            nativeAdmissionId: input.nativeAdmissionId,
          });
          return intent;
        }).pipe(Effect.provide(repositoryLayer())),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const row = yield* journal.reserve(input);
          expect(row).toMatchObject({ state: "reserved", revision: 2 });
          const retry = yield* journal.transition(row, "dispatch-intent", input.createdAt);
          const stale = yield* Effect.result(
            journal.reopenUndispatchedIntent!(intent, input.createdAt),
          );
          expect(stale._tag).toBe("Failure");
          expect(yield* journal.find(input)).toEqual(retry);
        }).pipe(Effect.provide(repositoryLayer())),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
