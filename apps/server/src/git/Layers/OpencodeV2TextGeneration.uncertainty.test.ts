import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { INTERNAL_TEXT_GENERATION_OPERATIONS } from "@bigbud/shared/internalTextGeneration";
import { makeV2AuxiliaryTextGenerator } from "../../provider/Layers/OpencodeV2/TextGeneration.native.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import {
  makeOpencodeV2TextGeneration,
  makeV2StructuredTextRunner,
} from "./OpencodeV2TextGeneration.ts";
import { runInternalTextGeneration } from "./InternalTextGenerationPolicy.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import { titleFixture } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.title.fixture.ts";
import {
  readTitleStage,
  recordTitleStage,
} from "../../orchestration/Layers/ProviderCommandReactorSessionOps.title.state.ts";

const input = {
  cwd: "/fixture",
  modelSelection: textGenerationSelection,
  message: "Repair native generation",
  transcript: "User: repair native generation",
  branch: "feature",
  stagedSummary: "Changes",
  stagedPatch: "Patch",
  baseBranch: "main",
  headBranch: "feature",
  commitSummary: "Commit",
  diffSummary: "Diff",
  diffPatch: "Patch",
};

type GenerationResult = Effect.Success<ReturnType<TextGenerationShape[keyof TextGenerationShape]>>;

function fixture(timeout = false) {
  const http = makeTextGenerationHttpFixture();
  let finish: ((text: string) => void) | undefined;
  if (timeout)
    http.options.generate = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
  else http.options.failGenerate = true;
  const native = makeV2AuxiliaryTextGenerator({ ...http, maxConcurrent: 1, timeoutMs: 10 });
  const service = makeOpencodeV2TextGeneration(
    makeV2StructuredTextRunner((request, signal) =>
      native({
        operation: request.operation,
        directory: request.cwd,
        prompt: request.prompt,
        selection: request.modelSelection,
        signal,
      }),
    ),
  );
  const fallback = vi.fn(() => Effect.succeed({ title: "Fallback must not run" }));
  const generate = (operation: (typeof INTERNAL_TEXT_GENERATION_OPERATIONS)[number]) =>
    runInternalTextGeneration<GenerationResult>({
      operation,
      preference: textGenerationSelection,
      successful: { provider: "claudeAgent", model: "distinct-successful" },
      generate: (selection) =>
        selection.provider === "opencodeV2" ? service[operation](input) : fallback(),
    });
  return { http, native, service, fallback, generate, finish: () => finish?.("late output") };
}

it.each(INTERNAL_TEXT_GENERATION_OPERATIONS)(
  "%s preserves lost-response uncertainty and never dispatches the distinct paid fallback",
  async (operation) => {
    const f = fixture();
    const error = await Effect.runPromise(f.generate(operation).pipe(Effect.flip));
    expect(error.kind).toBe("uncertain");
    expect(error.uncertaintyId).toBe([...f.http.sessions.keys()][0]);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.http.sessions.size).toBe(1);
    expect(f.http.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(
      1,
    );
    await expect(
      f.native({
        directory: "/fixture",
        operation,
        prompt: "no replay",
        selection: textGenerationSelection,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("capacity");
  },
);

it("preserves timeout uncertainty across native -> structured runner -> central policy", async () => {
  const f = fixture(true);
  const error = await Effect.runPromise(f.generate("generateThreadTitle").pipe(Effect.flip));
  expect(error.kind).toBe("uncertain");
  expect(f.fallback).not.toHaveBeenCalled();
  expect(f.http.sessions.size).toBe(1);
  await expect(
    f.native({
      directory: "/fixture",
      operation: "generateThreadTitle",
      prompt: "no replay",
      selection: textGenerationSelection,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("capacity");
  f.finish();
});

it("retained native sessions continue occupying auxiliary capacity after backend restart", async () => {
  const f = fixture();
  await Effect.runPromise(f.generate("generateThreadTitle").pipe(Effect.flip));
  const restarted = makeV2AuxiliaryTextGenerator({ ...f.http, maxConcurrent: 1 });
  await expect(
    restarted({
      directory: "/fixture",
      operation: "generateThreadTitle",
      prompt: "no replay",
      selection: textGenerationSelection,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("capacity");
  expect(f.http.sessions.size).toBe(1);
  expect(f.http.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(1);
});

it("still permits one fallback for a proven pre-dispatch refusal", async () => {
  const f = fixture();
  f.http.options.available = false;
  await Effect.runPromise(f.generate("generateThreadTitle"));
  expect(f.fallback).toHaveBeenCalledTimes(1);
  expect(f.http.requests.some(({ method }) => method === "POST")).toBe(false);
});

it("keeps verified output despite uncertain cleanup rather than paying for another result", async () => {
  const f = fixture();
  f.http.options.failGenerate = false;
  f.http.options.failDelete = true;
  expect(await Effect.runPromise(f.generate("generateThreadTitle"))).toEqual({
    title: "Repair native text generation",
  });
  expect(f.fallback).not.toHaveBeenCalled();
  expect(f.http.sessions.size).toBe(1);
});

it.each([false, true])(
  "lost response/timeout cannot enter legacy title replay when durable generation is unavailable (timeout=%s)",
  async (timeout) => {
    const f = fixture(timeout),
      title = titleFixture();
    const error = await Effect.runPromise(f.generate("generateThreadTitle").pipe(Effect.flip));
    expect(error.kind).toBe("uncertain");
    expect(error.uncertaintyId).toBe([...f.http.sessions.keys()][0]);
    title.reload();
    await Effect.runPromise(title.run());
    for (let index = 1; index <= 4; index++) title.addSuccess(index);
    await Effect.runPromise(title.run());
    await Effect.runPromise(title.run(true));
    expect(title.generate).not.toHaveBeenCalled();
    expect(title.dispatch).not.toHaveBeenCalled();
    expect(readTitleStage(title.thread, 1)).toBeNull();
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.http.sessions.size).toBe(1);
    expect(f.http.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(
      1,
    );
    f.finish();
  },
);

it("preserves a legacy protected claim without mutating or replaying it when durable generation is unavailable", async () => {
  const title = titleFixture();
  await Effect.runPromise(
    recordTitleStage(title.services, title.thread, 1, "started", undefined, true),
  );
  title.reload();
  const protectedClaim = readTitleStage(title.thread, 1);
  const activities = structuredClone(title.thread.activities);
  await Effect.runPromise(title.run());
  await Effect.runPromise(title.run(true));
  expect(title.generate).not.toHaveBeenCalled();
  expect(readTitleStage(title.thread, 1)).toEqual(protectedClaim);
  expect(protectedClaim?.state).toBe("started");
  expect(title.thread.activities).toEqual(activities);
});
