import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { DEFAULT_SERVER_SETTINGS, TextGenerationError } from "@bigbud/contracts";
import { makeInternalTextGenerationRouter } from "../../git/Layers/RoutingTextGeneration.ts";
import type {
  TextGenerationShape,
  ThreadTitleGenerationInput,
} from "../../git/Services/TextGeneration.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";

describe("staged title provider call bound", () => {
  it("makes at most six provider invocations, with no preference fallback in stages three or four", async () => {
    const f = titleFixture();
    f.addSuccess(1);
    const fail = (_input: ThreadTitleGenerationInput) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          kind: "provider",
          detail: "Candidate unavailable",
        }),
      );
    const preferred = vi.fn(fail),
      verified = vi.fn(fail);
    const router = makeInternalTextGenerationRouter({
      codex: { generateThreadTitle: preferred } as unknown as TextGenerationShape,
      claude: { generateThreadTitle: verified } as unknown as TextGenerationShape,
      cursor: {} as TextGenerationShape,
      serverSettingsService: {
        ...f.services.serverSettingsService,
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
        }),
      },
      opencodeServerManager: {} as typeof OpencodeServerManager.Service,
    });
    const services = { ...f.services, textGeneration: router };
    const run = () => maybeGenerateThreadTitleForFirstTurn(services)(f.input());
    await Effect.runPromise(run());
    expect(preferred).toHaveBeenCalledTimes(2);
    expect(verified).toHaveBeenCalledTimes(2);
    f.addSuccess(2);
    f.addSuccess(3, "actual-third");
    await Effect.runPromise(run());
    expect(preferred).toHaveBeenCalledTimes(2);
    expect(verified).toHaveBeenCalledTimes(4);
    expect(verified.mock.calls.slice(2).map(([input]) => input.modelSelection)).toEqual([
      { provider: "claudeAgent", model: "actual-third", subProviderID: undefined },
      { provider: "claudeAgent", model: "actual-third", subProviderID: undefined },
    ]);
    f.addSuccess(4);
    await Effect.runPromise(run());
    expect(preferred.mock.calls.length + verified.mock.calls.length).toBe(6);
  });
});
