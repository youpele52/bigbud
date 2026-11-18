import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import { OpencodeV2TextGenerationLive } from "./OpencodeV2TextGeneration.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { ThreadToolsActivation } from "../../provider/Services/OpencodeV2/ThreadToolsActivation.ts";
import { V2ConsentAuthority } from "../../provider/Layers/OpencodeV2/Application.consent.ts";
import { currentV2RequestContext } from "../../provider/Layers/OpencodeV2/Client.guard.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../provider/Layers/OpencodeV2/TextGeneration.connection.ts", () => ({
  connectV2TextGeneration: mocks.connect,
}));

describe("OpenCode V2 durable auxiliary routing composition", () => {
  it.each(["success", "rejected", "uncertain"] as const)(
    "uses the production Effect layer and native HTTP generation: %s",
    async (outcome) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-metadata-route-")));
      const serviceFile = join(directory, "synthetic-service.json");
      await writeFile(serviceFile, "Synthetic only: connector is mocked.");
      const settings = await Effect.runPromise(
        makeTestSettings({
          providers: {
            opencodeV2: { enabled: true, serviceFile, nativeServiceTrust: "host-user-v1" },
          },
        }),
      );
      const consent = new V2ConsentAuthority(settings);
      const fixture = makeTextGenerationHttpFixture(directory);
      fixture.options.failGenerate = outcome === "uncertain";
      mocks.connect.mockReset().mockImplementation(async (transport: string) => {
        expect(transport).toBe(serviceFile);
        expect(currentV2RequestContext()?.intent).toBe("execute");
        return fixture.connect();
      });
      const unexpected = vi.fn(() => Effect.die("Unexpected provider substitution"));
      const other: TextGenerationShape = {
        generateThreadTitle: unexpected,
        generateThreadElevatorSummary: unexpected,
        generateCommitMessage: unexpected,
        generatePrContent: unexpected,
        generateBranchName: unexpected,
        generatePromptSuggestion: unexpected,
      };
      const fence = vi.fn(() =>
        outcome === "rejected"
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Stale capture",
                metadataOutcome: "unavailable",
              }),
            )
          : Effect.void,
      );
      const request = Effect.gen(function* () {
        const v2 = yield* TextGeneration;
        const captured = yield* settings.getSettings;
        expect(captured.textGenerationModelSelection).toBeNull();
        const router = makeInternalTextGenerationRouter({
          codex: other,
          claude: other,
          cursor: other,
          opencodeV2: v2,
          serverSettingsService: {
            getSettings: Effect.die("Unexpected mutable routing settings read"),
          } as unknown as typeof ServerSettingsService.Service,
          opencodeServerManager: {} as typeof OpencodeServerManager.Service,
        });
        return yield* router.generateThreadTitle({
          cwd: directory,
          message: "Repair native text generation",
          modelSelection: textGenerationSelection,
          successfulModelSelection: { provider: "codex", model: "never-fallback" },
          metadataAttempt: {
            selection: textGenerationSelection,
            executionTarget: "local",
            providerSettings: captured.providers,
            beforeDispatch: fence,
          },
        });
      }).pipe(
        Effect.provide(OpencodeV2TextGenerationLive),
        Effect.provideService(ServerSettingsService, settings),
        Effect.provideService(ThreadToolsActivation, {
          consent,
        } as typeof ThreadToolsActivation.Service),
      );
      try {
        const result = await Effect.runPromise(Effect.result(request));
        expect(fence).toHaveBeenCalledTimes(1);
        expect(unexpected).not.toHaveBeenCalled();
        expect(
          fixture.requests.filter(({ pathname }) => pathname.endsWith("/generate")),
        ).toHaveLength(outcome === "rejected" ? 0 : 1);
        if (outcome === "success") {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success).toMatchObject({ actualModelSelection: textGenerationSelection });
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.metadataOutcome).toBe(
              outcome === "rejected" ? "unavailable" : "uncertain",
            );
        }
        expect(fixture.sessions.size).toBe(outcome === "uncertain" ? 1 : 0);
      } finally {
        consent.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
