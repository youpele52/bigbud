import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { legacyMaterials as frozen, legacyPolicy } from "./SharedService.legacy.fixture.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const model = { providerID: "synthetic-provider", id: "synthetic-model" };
const selection = {
  provider: "opencodeV2" as const,
  subProviderID: model.providerID,
  model: model.id,
};

for (const namespace of ["foreground", "learning"] as const) {
  it(`frozen unproved pre-API ${namespace} IDs/hash/policy/attachment bytes and journal remain read-only without native access or replay`, async () => {
    vi.stubEnv("XDG_DATA_HOME", "/frozen/data");
    vi.stubEnv("XDG_CONFIG_HOME", "/frozen/config");
    vi.stubEnv("XDG_STATE_HOME", "/frozen/state");
    try {
      await withV2RuntimeFixture(async ({ runtime, http, directory: workspace }) => {
        const directory = await realpath(workspace);
        const learning = namespace === "learning" ? frozen.learning : undefined;
        const threadId = ThreadId.makeUnsafe(learning?.threadId ?? frozen.threadId);
        const identity = {
          namespace,
          ownerThreadId: ThreadId.makeUnsafe(learning?.ownerThreadId ?? frozen.threadId),
          requestMessageId: MessageId.makeUnsafe(
            learning?.requestMessageId ?? frozen.requestMessageId,
          ),
        };
        const correlation = {
          nativeAdmissionId: learning?.nativeAdmissionId ?? frozen.nativeAdmissionId,
          turnId: TurnId.makeUnsafe(learning?.turnId ?? frozen.turnId),
        };
        // Only Location binds to the disposable workspace; opaque legacy IDs and hashed prompt/policy stay frozen.
        const binding = {
          provider: "opencodeV2" as const,
          threadId,
          nativeSessionId: learning?.nativeSessionId ?? frozen.nativeSessionId,
          location: directory,
          storageIdentity: frozen.storageIdentity,
          runtimeTargetId: "local",
          workspaceTargetId: "local",
        };
        let row = await Effect.runPromise(
          runtime.options.journal.reserve({
            ...identity,
            ...correlation,
            binding,
            fingerprint: frozen.fingerprint,
            createdAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        for (const state of ["dispatch-intent", "accepted", "terminal"] as const)
          row = await Effect.runPromise(
            runtime.options.journal.transition(
              row,
              state,
              "2026-10-01T00:00:01.000Z",
              state === "terminal" ? "frozen answer" : undefined,
              state === "terminal" ? "completed" : undefined,
            ),
          );
        const journalBytes = JSON.stringify(row);
        expect(row).toMatchObject({ ...correlation, fingerprint: frozen.fingerprint, revision: 3 });
        const native = {
          id: binding.nativeSessionId,
          projectID: "synthetic",
          location: { directory },
          model,
          metadata: {
            bigbud_provider: "opencodeV2",
            bigbud_thread: threadId,
            bigbud_storage: frozen.storageIdentity,
          },
          permissions: legacyPolicy,
          time: { created: 1, updated: 1 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        http.sessions.set(native.id, native);
        http.messages.set(native.id, [
          {
            id: correlation.nativeAdmissionId,
            type: "user",
            text: frozen.preparedText,
            time: { created: 2 },
            metadata: { bigbud_fingerprint: frozen.fingerprint },
          },
          {
            id: "msg_frozen_assistant",
            type: "assistant",
            agent: "build",
            model,
            time: { created: 3, completed: 4 },
            content: [{ type: "text", text: "frozen answer" }],
            finish: "stop",
            cost: 0,
            tokens: native.tokens,
          },
          { id: "msg_frozen_idle", type: "idle", outcome: "succeeded", time: { created: 5 } },
        ]);
        const root = path.join(directory, "private-admissions");
        await mkdir(root, { mode: 0o700 });
        const send = {
          threadId,
          requestMessageId: identity.requestMessageId,
          input: "Historical prompt",
          attachments: [frozen.attachment],
          ...(learning
            ? { learningJob: { ownerThreadId: identity.ownerThreadId, jobId: learning.jobId } }
            : {}),
        };
        const filename = path.join(
          root,
          `${digest([threadId, identity.requestMessageId, send.learningJob ?? null])}.json`,
        );
        const preparation = Buffer.from(
          JSON.stringify({
            request: digest([send.input, send.attachments, null]),
            binding: digest([native.id, directory, frozen.storageIdentity, "local", "local"]),
            text: frozen.preparedText,
            digest: frozen.mediaDigest,
            files: [],
          }),
        );
        await writeFile(filename, preparation, { mode: 0o600 });
        const originalBytes = Buffer.from(frozen.originalBytesBase64, "base64");
        expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
          "7889fbd09e975684914df4c6efdbb5c8219a7832bf6289acd5459532b78b933d",
        );
        const options = sharedV2FixtureOptions(runtime, http);
        options.config.sharedService.registrationFile = "/frozen/state/opencode/service.json";
        const shared = new OpencodeV2Runtime({
          ...options,
          enableLocalTools: true,
          attachmentAdmissionsDir: root,
        });
        const input = {
          threadId,
          cwd: directory,
          runtimeMode: "approval-required" as const,
          modelSelection: selection,
        };
        const cursor = {
          provider: "opencodeV2",
          nativeSessionId: native.id,
          storageIdentity: frozen.storageIdentity,
          directory,
          model,
        };
        try {
          const before = http.calls.length;
          await expect(
            shared.start({
              ...input,
              resumeCursor: { ...cursor, nativeSessionId: "ses_conflicting_cursor" },
            }),
          ).rejects.toThrow("unsupported-retained-binding");
          expect(http.calls).toHaveLength(before);
          expect(
            await Effect.runPromise(runtime.options.sharedBindings!.find(threadId)),
          ).toBeUndefined();
          expect(
            JSON.stringify(await Effect.runPromise(runtime.options.journal.latestBound(threadId))),
          ).toBe(journalBytes);
          await expect(shared.start({ ...input, resumeCursor: cursor })).rejects.toThrow(
            "unsupported-retained-binding",
          );
          expect(http.calls).toHaveLength(before);
          expect(http.sessions.get(native.id)).toEqual(native);
          expect(
            JSON.stringify(await Effect.runPromise(runtime.options.journal.latestBound(threadId))),
          ).toBe(journalBytes);
          expect(await readFile(filename)).toEqual(preparation);
          expect(
            http.calls.some(
              (call) =>
                call.pathname.endsWith("/prompt") ||
                (call.method === "POST" && call.pathname === "/api/session"),
            ),
          ).toBe(false);
        } finally {
          await shared.close();
        }
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
}
