import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import { describe, expect, it, vi } from "vitest";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../provider/Layers/Copilot/Runtime.client.ts", () => ({
  createLeasedCopilotClient: sdk.create,
}));

describe("SDK auxiliary routing with real one-shot helpers", () => {
  // Injected legacy manager qualifies only this helper contract, NOT retired production execution.
  for (const provider of ["copilot", "opencode"] as const) {
    for (const field of ["title", "summary"] as const) {
      const outcomes = [
        "success",
        "rejected",
        "uncertain",
        ...(field === "summary" ? (["invalid", "empty"] as const) : []),
        ...(provider === "copilot"
          ? (["client-start", "session-start", "cleanup-failed"] as const)
          : []),
      ] as const;
      it.each(outcomes)(`${provider} ${field}: %s`, async (outcome) => {
        const setupFailed = outcome === "client-start" || outcome === "session-start";
        const noSend = setupFailed || outcome === "rejected";
        const successful = outcome === "success" || outcome === "cleanup-failed";
        const text = "Repair durable metadata recovery";
        const structured =
          outcome === "invalid" ? { [field]: 42 } : { [field]: outcome === "empty" ? "" : text };
        const send = vi.fn(async () => {
          if (outcome === "uncertain") throw new Error("private provider error");
          return {
            data: {
              content: field === "title" && successful ? text : JSON.stringify(structured),
            },
          };
        });
        const disconnect = vi.fn(async () => {
          if (outcome === "cleanup-failed") throw new Error("private cleanup failure");
        });
        const stop = vi.fn(async () => {
          if (outcome === "cleanup-failed") throw new Error("private cleanup failure");
          return [];
        });
        const createSession = vi.fn(async () => {
          if (outcome === "session-start") throw new Error("private setup failure");
          return { sendAndWait: send, disconnect };
        });
        sdk.create.mockReset();
        if (outcome === "client-start")
          sdk.create.mockRejectedValue(new Error("private startup failure"));
        else sdk.create.mockResolvedValue({ createSession, stop });
        const prompt = vi.fn(async () => {
          if (outcome === "uncertain") throw new Error("private provider error");
          return { data: { info: { role: "assistant", structured }, parts: [] } };
        });
        const release = vi.fn();
        const acquire = vi.fn(async () => ({
          client: { session: { create: async () => ({ data: { id: "synthetic" } }), prompt } },
          release,
        }));
        const other = vi.fn(() => Effect.die("Unexpected second provider"));
        const service: TextGenerationShape = {
          generateThreadTitle: other,
          generateThreadElevatorSummary: other,
          generateCommitMessage: other,
          generateBranchName: other,
          generatePrContent: other,
          generatePromptSuggestion: other,
        };
        const router = makeInternalTextGenerationRouter({
          codex: service,
          claude: service,
          cursor: service,
          serverSettingsService: {
            getSettings: Effect.die("Unexpected mutable settings read"),
          } as unknown as typeof ServerSettingsService.Service,
          opencodeServerManager: { acquire } as unknown as typeof OpencodeServerManager.Service,
        });
        const settings = {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            [provider]: {
              ...DEFAULT_SERVER_SETTINGS.providers[provider],
              enabled: true,
              binaryPath: `/captured/${provider}`,
            },
          },
        };
        expect(settings.textGenerationModelSelection).toBeNull();
        const selection =
          provider === "copilot"
            ? { provider, model: "exact", options: { reasoningEffort: "high" as const } }
            : {
                provider,
                model: "exact",
                subProviderID: "exact-account",
                options: { reasoningEffort: "high" as const },
              };
        const fence = vi.fn(() =>
          outcome === "rejected"
            ? Effect.fail(
                new TextGenerationError({
                  operation:
                    field === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary",
                  detail: "Stale",
                  metadataOutcome: "unavailable",
                }),
              )
            : Effect.void,
        );
        const input = {
          cwd: "/fixture",
          modelSelection: selection,
          successfulModelSelection: { provider: "codex" as const, model: "never-substitute" },
          metadataAttempt: {
            selection,
            executionTarget: "local",
            providerSettings: settings.providers,
            beforeDispatch: fence,
          },
        };
        const generation: Effect.Effect<object, TextGenerationError> =
          field === "title"
            ? router.generateThreadTitle({ ...input, message: "Repair metadata" })
            : router.generateThreadElevatorSummary({ ...input, transcript: "Repair metadata" });
        const result = await Effect.runPromise(generation.pipe(Effect.result));
        expect(fence).toHaveBeenCalledTimes(setupFailed ? 0 : 1);
        expect(other).not.toHaveBeenCalled();
        expect(provider === "copilot" ? send : prompt).toHaveBeenCalledTimes(noSend ? 0 : 1);
        if (successful) {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success).toMatchObject({
              [field]: text,
              actualModelSelection: selection,
            });
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.metadataOutcome).toBe(
              noSend ? "unavailable" : outcome === "uncertain" ? "uncertain" : "failed",
            );
        }
        if (provider === "copilot") {
          expect(sdk.create).toHaveBeenCalledWith({
            binaryPath: "/captured/copilot",
            workingDirectory: "/fixture",
          });
          expect(createSession).toHaveBeenCalledTimes(outcome === "client-start" ? 0 : 1);
          if (outcome !== "client-start")
            expect(createSession).toHaveBeenCalledWith(
              expect.objectContaining({
                model: "exact",
                reasoningEffort: "high",
                availableTools: [],
              }),
            );
          if (!noSend)
            expect(send).toHaveBeenCalledWith(
              { prompt: expect.stringContaining("Repair metadata"), mode: "immediate" },
              60_000,
            );
          expect(disconnect).toHaveBeenCalledTimes(setupFailed ? 0 : 1);
          expect(stop).toHaveBeenCalledTimes(outcome === "client-start" ? 0 : 1);
        } else {
          expect(acquire).toHaveBeenCalledWith(
            expect.objectContaining({ provider: "opencode", executionTargetId: "local" }),
          );
          expect(release).toHaveBeenCalledTimes(1);
        }
      });
    }
  }
});
