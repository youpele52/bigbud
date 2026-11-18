import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vitest";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import { OpencodeV2TextGenerationLive } from "./OpencodeV2TextGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { ThreadToolsActivation } from "../../provider/Services/OpencodeV2/ThreadToolsActivation.ts";
import { V2ConsentAuthority } from "../../provider/Layers/OpencodeV2/Application.consent.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import { ThreadMetadataGenerationRepository } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { makeMetadataCoordinator } from "../../orchestration/Layers/ThreadMetadataGeneration.coordinator.ts";
import {
  capturedTitle,
  coordinatorTestLayer,
  makeCoordinatorFixture,
} from "../../orchestration/Layers/ThreadMetadataGeneration.coordinator.test-helpers.ts";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../provider/Layers/OpencodeV2/TextGeneration.connection.ts", () => ({
  connectV2TextGeneration: mocks.connect,
}));

it("retains real V2 dispatch uncertainty across durable recomposition without renewing budgets", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-metadata-recovery-")));
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
  const http = makeTextGenerationHttpFixture(directory);
  http.options.failGenerate = true;
  mocks.connect.mockReset().mockImplementation(() => http.connect());
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ThreadMetadataGenerationRepository;
        const v2 = yield* TextGeneration;
        const f = makeCoordinatorFixture(repository);
        const original = capturedTitle();
        const path = { ...original.primaryPath!, selection: textGenerationSelection };
        const context = {
          ...original,
          configuredPrimary: false,
          primaryPath: path,
          threadPath: path,
          workspace: { ...original.workspace, cwd: directory },
        };
        expect((yield* settings.getSettings).textGenerationModelSelection).toBeNull();
        const unexpected = vi.fn(() => Effect.die("Unexpected second provider"));
        const router = makeInternalTextGenerationRouter({
          codex: { generateThreadTitle: unexpected } as never,
          claude: { generateThreadTitle: unexpected } as never,
          cursor: { generateThreadTitle: unexpected } as never,
          opencodeV2: v2,
          serverSettingsService: settings,
          opencodeServerManager: {} as never,
        });
        const host = {
          ...f.host,
          providerSettings: () =>
            settings.getSettings.pipe(
              Effect.map((s) => s.providers),
              Effect.orDie,
            ),
        };
        const compose = () => makeMetadataCoordinator({ repository, textGeneration: router, host });
        const job = yield* f.create(context);
        yield* compose().step(job.jobId);
        const retained = (yield* repository.listAttempts(job.jobId))[0]!;
        expect(retained.state).toBe("uncertain");
        f.advance(86_400_000);
        f.control.current = false;
        const resumed = compose();
        for (let step = 0; step < 3; step++) yield* resumed.step(job.jobId);
        expect((yield* f.create(context)).jobId).toBe(job.jobId);
        expect(yield* repository.listAttempts(job.jobId)).toEqual([retained]);
        expect(Option.getOrThrow(yield* repository.get(job.jobId)).deadlineAt).toBe(job.deadlineAt);
        expect(f.control.commits).toEqual([]);
        expect(unexpected).not.toHaveBeenCalled();
        expect(http.sessions.size).toBe(1);
        expect(http.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(
          1,
        );
      }).pipe(
        Effect.provide(OpencodeV2TextGenerationLive),
        Effect.provideService(ServerSettingsService, settings),
        Effect.provideService(ThreadToolsActivation, {
          consent,
        } as typeof ThreadToolsActivation.Service),
        Effect.provide(coordinatorTestLayer),
      ),
    );
  } finally {
    consent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
