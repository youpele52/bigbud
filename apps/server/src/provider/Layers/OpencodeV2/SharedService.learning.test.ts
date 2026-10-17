import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";

vi.mock("./SharedService.connection.ts", () => ({ borrowV2SharedService: vi.fn() }));

it("retains unproved isolated hidden learning locally without adopting or replaying its terminal journal", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const request = {
      ownerThreadId: ThreadId.makeUnsafe("learning-legacy-owner"),
      jobId: "legacy-terminal-job",
      cwd: directory,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
      input: "retained review",
    };
    const identity = learningAdmissionIdentity(request.ownerThreadId, request.jobId);
    await Effect.runPromise(makeV2LearningReview(runtime)(request));
    const original = await Effect.runPromise(runtime.options.journal.find(identity.identity));
    const close = vi.fn(async () => {});
    vi.mocked(borrowV2SharedService).mockResolvedValue({
      ownership: "borrowed",
      client: http.client,
      isRunning: () => true,
      hasExited: () => false,
      onDeath: () => () => {},
      close,
    });
    const shared = new OpencodeV2Runtime({
      ...runtime.options,
      config: {
        runtimeTargetId: "local",
        sharedService: {
          registrationFile: "/fixture/service.json",
          generation: "logical-fixture",
          storageIdentity: "new-binding-only-seed",
        },
      },
    });
    const acquire = vi.spyOn(runtime.options.manager, "acquire");
    try {
      expect(
        (await Effect.runPromise(makeV2LearningReview(shared)(request).pipe(Effect.result)))._tag,
      ).toBe("Failure");
      expect(await Effect.runPromise(runtime.options.journal.find(identity.identity))).toEqual(
        original,
      );
      expect(
        await Effect.runPromise(runtime.options.sharedBindings!.find(identity.threadId)),
      ).toBeUndefined();
      expect(acquire).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(borrowV2SharedService).not.toHaveBeenCalled();
      http.sessions.delete(original!.binding.nativeSessionId);
      expect(
        (await Effect.runPromise(makeV2LearningReview(shared)(request).pipe(Effect.result)))._tag,
      ).toBe("Failure");
      expect(await Effect.runPromise(runtime.options.journal.find(identity.identity))).toEqual(
        original,
      );
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(1);
    } finally {
      acquire.mockRestore();
      await shared.close();
    }
  });
});
