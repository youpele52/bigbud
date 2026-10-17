import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { ProjectId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { reviewAndUpdateMemory } from "../../../learning/LearningReview.ts";
import type { ServerConfigShape } from "../../../startup/config.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";

for (const completed of [true, false])
  it(`skill edits cannot regenerate the same durable learning admission (${completed ? "terminal fingerprint conflict" : "unconfirmed outcome"})`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      http.autoComplete = completed;
      const complete = http.complete.bind(http);
      vi.spyOn(http, "complete").mockImplementation((id) =>
        complete(
          id,
          JSON.stringify({
            userMemory: null,
            globalMemory: null,
            projectMemory: null,
            skillPatch: null,
          }),
        ),
      );
      const review = makeV2LearningReview(runtime);
      const prompts: string[] = [];
      const ownerThreadId = ThreadId.makeUnsafe(`skill-edit-${completed}`);
      const projectId = ProjectId.makeUnsafe("synthetic-project");
      const jobId = "same-durable-job";
      const run = (content: string) =>
        reviewAndUpdateMemory({
          jobId,
          turnId: "synthetic-turn",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
          thread: {
            id: ownerThreadId,
            projectId,
            messages: [],
            worktreePath: null,
          } as unknown as OrchestrationThread,
          projects: [{ id: projectId, workspaceRoot: directory }],
          config: { cwd: directory } as ServerConfigShape,
          sourceUserMessage: "synthetic skill evidence",
          memoryReviewEnabled: false,
          skillContext: { path: "synthetic/SKILL.md", content, sameProviderExamples: [] },
          memoryStore: {
            read: () => Effect.die("memory disabled"),
            write: () => Effect.die("must not apply memory"),
          },
          providerService: {
            runBackgroundReview: (
              request: Parameters<ProviderServiceShape["runBackgroundReview"]>[0],
            ) => {
              prompts.push(request.input);
              return review(request);
            },
          } as unknown as ProviderServiceShape,
        });
      if (completed) await Effect.runPromise(run("original skill content"));
      else {
        const first = Effect.runFork(run("original skill content"));
        await expect
          .poll(() => http.calls.filter((call) => call.pathname.endsWith("/prompt")).length)
          .toBe(1);
        await Effect.runPromise(Fiber.interrupt(first));
      }
      const identity = learningAdmissionIdentity(ownerThreadId, jobId).identity;
      const before = await Effect.runPromise(runtime.options.journal.find(identity));
      await expect(Effect.runPromise(run("edited skill content"))).rejects.toThrow(
        "No resend or result application",
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toBe(prompts[1]);
      expect(prompts[0]).toContain("original skill content");
      expect(prompts[1]).toContain("edited skill content");
      expect(await Effect.runPromise(runtime.options.journal.find(identity))).toEqual(before);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
      ).toHaveLength(1);
      // The changed prompt conflicts with the original terminal fingerprint, or the admission
      // remains uncertain. Neither licenses regeneration or application of a result to edited input.
    });
  });
