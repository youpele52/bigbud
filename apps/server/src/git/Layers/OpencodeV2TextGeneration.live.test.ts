import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { OpencodeV2TextGenerationLive } from "./OpencodeV2TextGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { ThreadToolsActivation } from "../../provider/Services/OpencodeV2/ThreadToolsActivation.ts";
import { V2ConsentAuthority } from "../../provider/Layers/OpencodeV2/Application.consent.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import { currentV2RequestContext } from "../../provider/Layers/OpencodeV2/Client.guard.ts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../provider/Layers/OpencodeV2/TextGeneration.connection.ts", () => ({
  connectV2TextGeneration: mocks.connect,
}));

it("production Effect layer uses accepted native trust and the canonical transport without plugin activation or chat admission", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-textgen-")));
  const serviceFile = join(directory, "synthetic-service.json");
  await writeFile(serviceFile, "Synthetic only: connector is mocked.");
  const settings = await Effect.runPromise(
    makeTestSettings({
      providers: {
        opencodeV2: {
          enabled: true,
          serviceFile,
          nativeServiceTrust: "host-user-v1",
        },
      },
    }),
  );
  const consent = new V2ConsentAuthority(settings);
  const http = makeTextGenerationHttpFixture(directory);
  mocks.connect.mockImplementation(async (transport: string, signal: AbortSignal) => {
    expect(transport).toBe(serviceFile);
    expect(currentV2RequestContext()?.permit.signal.aborted).toBe(false);
    signal.throwIfAborted();
    return http.connect();
  });
  const request = Effect.gen(function* () {
    const service = yield* TextGeneration;
    return yield* service.generateThreadTitle({
      cwd: directory,
      message: "Repair native text generation",
      modelSelection: textGenerationSelection,
    });
  }).pipe(
    Effect.provide(OpencodeV2TextGenerationLive),
    Effect.provideService(ServerSettingsService, settings),
    Effect.provideService(ThreadToolsActivation, {
      consent,
    } as typeof ThreadToolsActivation.Service),
  );
  try {
    expect(await Effect.runPromise(request)).toEqual({ title: "Repair native text generation" });
    expect(http.sessions.size).toBe(0);
    expect(http.options.closed).toBe(1);
    await Effect.runPromise(
      settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
    );
    const error = await Effect.runPromise(request.pipe(Effect.flip));
    expect(error.kind).toBe("cancelled");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(http.requests.some(({ pathname }) => /prompt|rpc|config|inbox/.test(pathname))).toBe(
      false,
    );
  } finally {
    consent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["disable", "revoke"] as const)(
  "%s after routing cannot silently migrate the captured native job to a fallback",
  async (change) => {
    mocks.connect.mockClear();
    const settings = await Effect.runPromise(
      makeTestSettings({
        textGenerationModelSelection: textGenerationSelection,
        providers: {
          opencodeV2: {
            enabled: true,
            nativeServiceTrust: "host-user-v1",
            serviceFile: "/synthetic/not-read/service.json",
          },
        },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    const fallback = vi.fn(() => Effect.succeed({ title: "Must not migrate" }));
    const request = Effect.gen(function* () {
      const native = yield* TextGeneration;
      const router = makeInternalTextGenerationRouter({
        codex: {} as never,
        cursor: {} as never,
        claude: { generateThreadTitle: fallback } as never,
        opencodeV2: native,
        serverSettingsService: settings,
        opencodeServerManager: {} as never,
      });
      return yield* router.generateThreadTitle({
        cwd: "/fixture",
        message: "Keep the exact native job",
        modelSelection: textGenerationSelection,
        successfulModelSelection: { provider: "claudeAgent", model: "verified-fallback" },
        beforeV2Dispatch: () =>
          settings
            .updateSettings({
              providers: {
                opencodeV2:
                  change === "disable" ? { enabled: false } : { nativeServiceTrust: null },
              },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new TextGenerationError({
                    operation: "fixture",
                    detail: "Settings update failed",
                  }),
              ),
            ),
      });
    }).pipe(
      Effect.provide(OpencodeV2TextGenerationLive),
      Effect.provideService(ServerSettingsService, settings),
      Effect.provideService(ThreadToolsActivation, {
        consent,
      } as typeof ThreadToolsActivation.Service),
    );
    try {
      expect((await Effect.runPromise(request.pipe(Effect.flip))).kind).toBe("cancelled");
      expect(fallback).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    } finally {
      consent.close();
    }
  },
);
