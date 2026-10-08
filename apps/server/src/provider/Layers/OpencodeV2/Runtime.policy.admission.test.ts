import { createHash } from "node:crypto";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";
import { admissionCorrelation, learningAdmissionIdentity } from "./Admission.identity.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";

const modelSelection = {
  provider: "opencodeV2",
  model: "synthetic-model",
  subProviderID: "synthetic-provider",
} as const;
for (const remote of [false, true]) {
  it(`SQLite ${remote ? "synthetic remote" : "local"} supervised admission cannot become Auto edits on settings-driven owner restart; unchanged accepted/terminal policy deduplicates`, async () => {
    await withV2RuntimeFixture(async ({ runtime: fixture, http, directory }) => {
      http.autoComplete = false;
      const hold = await fixture.options.manager.acquire(fixture.options.config);
      const coding = await V2CodingBridge.open(
        fixture.options.config.profileRoot,
        await resolveV2FilePython(fixture.options.config.profileRoot),
      );
      const options = {
        ...fixture.options,
        codingBridge: coding,
        enableLocalTools: true,
        pollIntervalMs: 100000,
      };
      const agent = remote
        ? await makeV2RemoteAgentFixture(directory, options.config.profileRoot)
        : undefined;
      const runtime = new OpencodeV2Runtime({
        ...options,
        ...(remote
          ? {
              prepareSession: makeV2TargetPreparation(
                options,
                options.config.profileRoot,
                async () => agent!.client,
              ),
            }
          : {}),
      });
      const threadId = ThreadId.makeUnsafe(`policy-owner-${remote}`),
        input = {
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe(`policy-message-${remote}`),
          input: "same exact action",
        };
      const start = (runtimeMode: "approval-required" | "auto-accept-edits") =>
        runtime.start({
          threadId,
          cwd: directory,
          modelSelection,
          runtimeMode,
          ...(remote
            ? {
                workspaceExecutionTargetId:
                  "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key&transport=agent",
                providerRuntimeExecutionTargetId: "local",
              }
            : {}),
        });
      try {
        await start("approval-required");
        const supervised = runtime.get(threadId).toolPolicy;
        await runtime.send(input);
        const row = runtime.get(threadId).row!;
        expect(row.state).toBe("accepted");
        await runtime.send(input);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        http.complete(runtime.get(threadId).native.id);
        await runtime.reconcile(runtime.get(threadId));
        expect(runtime.get(threadId).row?.state).toBe("terminal");
        await runtime.send(input);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        await runtime.stop(threadId);
        await start("auto-accept-edits");
        if (remote) expect(runtime.get(threadId).toolPolicy).toEqual(supervised);
        await expect(runtime.send(input)).rejects.toThrow();
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        expect(
          (
            await Effect.runPromise(
              options.journal.find({
                namespace: "foreground",
                ownerThreadId: threadId,
                requestMessageId: input.requestMessageId,
              }),
            )
          )?.fingerprint,
        ).toBe(row.fingerprint);
        await runtime.stop(threadId);
        await start("approval-required");
        await runtime.send(input);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        // Native-rule-only legacy hashes must fail closed, not be reinterpreted under the new canonical mode.
        const identity = {
          namespace: "foreground" as const,
          ownerThreadId: threadId,
          requestMessageId: MessageId.makeUnsafe(`legacy-policy-${remote}`),
        };
        const legacy = createHash("sha256")
          .update(
            JSON.stringify([
              input.input,
              modelSelection.subProviderID,
              modelSelection.model,
              null,
              createHash("sha256").update("[]").digest("hex"),
              JSON.stringify(supervised),
            ]),
          )
          .digest("hex");
        await Effect.runPromise(
          options.journal.reserve({
            ...row,
            ...identity,
            ...admissionCorrelation(identity),
            fingerprint: legacy,
          }),
        );
        await expect(
          runtime.send({ ...input, requestMessageId: identity.requestMessageId }),
        ).rejects.toThrow();
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        expect((await Effect.runPromise(options.journal.find(identity)))?.fingerprint).toBe(legacy);
      } finally {
        await runtime.close().catch(() => {});
        coding.close();
        await hold.release();
      }
    });
  });
}

it("SQLite learning terminal replay uses the disabled effective policy; native-rule-only legacy terminal hashes cannot be applied or regenerated", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const review = makeV2LearningReview(runtime);
    const request = {
      ownerThreadId: ThreadId.makeUnsafe("learning-policy-owner"),
      jobId: "current-policy",
      cwd: directory,
      input: "same review",
      modelSelection,
    };
    const result = await Effect.runPromise(review(request));
    const dispatches = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
    expect(await Effect.runPromise(review(request))).toBe(result);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(dispatches);
    const current = await Effect.runPromise(
      runtime.options.journal.find(
        learningAdmissionIdentity(request.ownerThreadId, request.jobId).identity,
      ),
    );
    const owned = learningAdmissionIdentity(request.ownerThreadId, "legacy-policy");
    const legacyHash = createHash("sha256")
      .update(
        JSON.stringify([
          request.input,
          modelSelection.subProviderID,
          modelSelection.model,
          null,
          createHash("sha256").update("[]").digest("hex"),
          "isolated-deny-tools",
        ]),
      )
      .digest("hex");
    let legacy = await Effect.runPromise(
      runtime.options.journal.reserve({
        ...current!,
        ...owned.identity,
        ...admissionCorrelation(owned.identity),
        fingerprint: legacyHash,
        binding: { ...current!.binding, threadId: owned.threadId },
      }),
    );
    for (const state of ["dispatch-intent", "accepted"] as const)
      legacy = await Effect.runPromise(
        runtime.options.journal.transition(legacy, state, new Date().toISOString()),
      );
    legacy = await Effect.runPromise(
      runtime.options.journal.transition(
        legacy,
        "terminal",
        new Date().toISOString(),
        result,
        "completed",
      ),
    );
    await expect(
      Effect.runPromise(review({ ...request, jobId: "legacy-policy" })),
    ).rejects.toThrow();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(dispatches);
    expect(
      (await Effect.runPromise(runtime.options.journal.find(owned.identity)))?.fingerprint,
    ).toBe(legacyHash);
  });
});
