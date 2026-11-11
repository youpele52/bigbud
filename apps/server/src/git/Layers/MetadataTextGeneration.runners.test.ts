import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

import type { MetadataTextGenerationAttempt } from "../Services/TextGeneration.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeClaudeJsonRunner } from "./ClaudeTextGeneration.runner.ts";
import { makeCodexJsonRunner } from "./CodexTextGeneration.runner.ts";
import { runMetadataGenerationAttempt } from "./MetadataTextGeneration.ts";

const title = "Repair durable metadata recovery";
const operation = "generateThreadTitle";
const outputSchema = Schema.Struct({ title: Schema.String });
const encoder = new TextEncoder();

function fixture(
  provider: "codex" | "claudeAgent",
  outcome: "valid" | "invalid" | "rejected",
  refuse = false,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let fenced = false;
    const beforeDispatch = vi.fn(() =>
      Effect.sync(() => {
        fenced = true;
      }).pipe(
        Effect.andThen(
          refuse
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Claim refused",
                  metadataOutcome: "unavailable",
                }),
              )
            : Effect.void,
        ),
      ),
    );
    const selection =
      provider === "codex"
        ? { provider, model: "captured-model", options: { reasoningEffort: "high" as const } }
        : { provider, model: "claude-sonnet-4-6", options: { effort: "high" as const } };
    const providerSettings = {
      ...DEFAULT_SERVER_SETTINGS.providers,
      [provider]: {
        ...DEFAULT_SERVER_SETTINGS.providers[provider],
        binaryPath: "/captured-provider-binary",
      },
    };
    const settingsRead = vi.fn(() => DEFAULT_SERVER_SETTINGS);
    const settings = {
      getSettings: Effect.sync(settingsRead),
    } as unknown as typeof ServerSettingsService.Service;
    const spawn = vi.fn(
      (
        command: Parameters<typeof ChildProcessSpawner.make>[0] extends (
          command: infer C,
        ) => unknown
          ? C
          : never,
      ) =>
        Effect.gen(function* () {
          expect(fenced).toBe(true);
          const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
          expect(cmd.command).toBe("/captured-provider-binary");
          expect(cmd.args).toContain(selection.model);
          const raw = outcome === "valid" ? JSON.stringify({ title }) : "invalid JSON";
          if (provider === "codex") {
            expect(cmd.args).toContain('model_reasoning_effort="high"');
            yield* fs
              .writeFileString(cmd.args[cmd.args.indexOf("--output-last-message") + 1]!, raw)
              .pipe(Effect.orDie);
          } else {
            expect(cmd.args).toContain("--effort");
            expect(cmd.args).toContain("high");
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(outcome === "rejected" ? 1 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.make(
              encoder.encode(
                provider === "claudeAgent" && outcome === "valid"
                  ? JSON.stringify({ structured_output: { title } })
                  : raw,
              ),
            ),
            stderr: Stream.make(encoder.encode("private provider rejection")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
    );
    const spawner = ChildProcessSpawner.make(spawn);
    const metadataAttempt: MetadataTextGenerationAttempt = {
      selection,
      providerSettings,
      executionTarget: "local",
      beforeDispatch,
    };
    const effect = runMetadataGenerationAttempt({
      operation,
      attempt: metadataAttempt,
      generate: (attempt) => {
        const args = {
          operation: "generateThreadTitle" as const,
          cwd: "/fixture",
          prompt: "Generate metadata",
          outputSchemaJson: outputSchema,
          metadataAttempt: attempt,
        };
        return selection.provider === "codex"
          ? makeCodexJsonRunner(fs, spawner, settings)({ ...args, modelSelection: selection })
          : makeClaudeJsonRunner(spawner, settings)({ ...args, modelSelection: selection });
      },
    });
    const result = yield* effect.pipe(Effect.result);
    expect(settingsRead).not.toHaveBeenCalled();
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(refuse ? 0 : 1);
    return result;
  }).pipe(Effect.provide(NodeServices.layer));
}

describe("metadata fences at subprocess submission", () => {
  it.each(["codex", "claudeAgent"] as const)(
    "uses captured %s settings and crosses one fence",
    async (provider) => {
      const result = await Effect.runPromise(fixture(provider, "valid"));
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.title).toBe(title);
    },
  );

  it.each(["codex", "claudeAgent"] as const)(
    "does not spawn %s when claim is refused",
    async (provider) => {
      const result = await Effect.runPromise(fixture(provider, "valid", true));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.metadataOutcome).toBe("unavailable");
    },
  );

  it.each(["codex", "claudeAgent"] as const)(
    "counts terminal %s rejection or invalid output as failed",
    async (provider) => {
      for (const outcome of ["invalid", "rejected"] as const) {
        const result = await Effect.runPromise(fixture(provider, outcome));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.metadataOutcome).toBe("failed");
          expect(JSON.stringify(result.failure)).not.toContain("private provider rejection");
        }
      }
    },
  );
});
