import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { setup } from "./OrchestrationEngine.metadataGeneration.test-helpers.ts";
import { createRuntime, withDatabase } from "./OrchestrationEngine.test.runtime.ts";
import { withAdmissionFixture } from "./ThreadMetadataGeneration.admission.test-helpers.ts";
import { makeMetadataCanonicalOperations } from "./ThreadMetadataGeneration.canonical.ts";
import {
  makeMetadataConfiguration,
  metadataConfigurationFingerprint,
} from "./ThreadMetadataGeneration.configuration.ts";
import { capturedTitle } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";

const configurationFor = (runtime: ReturnType<typeof createRuntime>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const configuration = yield* makeMetadataConfiguration(settings);
      return {
        settings,
        configuration,
        epoch: settings.withSnapshotBarrier!(configuration.epochFor),
      };
    }),
  );
const selection = capturedTitle().primaryPath!.selection;

describe("metadata configuration authority", () => {
  it("ignores discovery lists, unrelated provider settings and unrelated settings", () =>
    withDatabase("bigbud-metadata-config-fingerprint-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        await runtime.runPromise(
          settings.updateSettings({ textGenerationModelSelection: selection }),
        );
        const original = await runtime.runPromise(epoch);
        const before = await runtime.runPromise(settings.getSettings);
        const provider = before.providers[selection.provider];
        expect(
          metadataConfigurationFingerprint({
            ...before,
            providers: {
              ...before.providers,
              [selection.provider]: { ...provider, customModels: ["discovered-model"] },
            },
          }),
        ).toBe(metadataConfigurationFingerprint(before));
        await runtime.runPromise(
          settings.updateSettings({ defaultChatCwd: "/tmp/irrelevant-config" }),
        );
        expect(await runtime.runPromise(epoch)).toBe(original);
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(true);
        const other = selection.provider === "claudeAgent" ? "codex" : "claudeAgent";
        await runtime.runPromise(
          settings.updateSettings({ providers: { [other]: { binaryPath: "unrelated-binary" } } }),
        );
        expect(await runtime.runPromise(epoch)).toBe(original);
      } finally {
        await runtime.dispose();
      }
    }));

  it("synchronously rejects A -> B -> A before persisting another epoch, across factories", () =>
    withDatabase("bigbud-metadata-config-aba-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        const original = await runtime.runPromise(epoch);
        const second = await runtime.runPromise(makeMetadataConfiguration(settings));
        await runtime.runPromise(
          settings.updateSettings({ textGenerationModelSelection: selection }),
        );
        await runtime.runPromise(settings.updateSettings({ textGenerationModelSelection: null }));
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(false);
        expect(await runtime.runPromise(second.isCurrent(original))).toBe(false);
        const replacement = await runtime.runPromise(epoch);
        expect(replacement).not.toBe(original);
        expect(await runtime.runPromise(second.isCurrent(replacement))).toBe(true);
      } finally {
        await runtime.dispose();
      }
    }));

  it("invalidates selected provider configuration but ignores its custom model discovery", () =>
    withDatabase("bigbud-metadata-config-provider-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        await runtime.runPromise(
          settings.updateSettings({ textGenerationModelSelection: selection }),
        );
        const original = await runtime.runPromise(epoch);
        await runtime.runPromise(
          settings.updateSettings({
            providers: { [selection.provider]: { customModels: ["new-model"] } },
          }),
        );
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(true);
        await runtime.runPromise(
          settings.updateSettings({
            providers: { [selection.provider]: { binaryPath: "replacement-binary" } },
          }),
        );
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(false);
        expect(await runtime.runPromise(epoch)).not.toBe(original);
      } finally {
        await runtime.dispose();
      }
    }));

  it("retains a durable epoch on restart with unchanged accepted settings", () =>
    withDatabase("bigbud-metadata-config-restart-", async (dbPath) => {
      const first = createRuntime(dbPath);
      let original: string;
      try {
        original = await first.runPromise((await configurationFor(first)).epoch);
      } finally {
        await first.dispose();
      }
      const second = createRuntime(dbPath);
      try {
        const f = await configurationFor(second);
        // Freshness can be checked by commit hooks before capture initializes epochFor.
        expect(await second.runPromise(f.configuration.isCurrent(original!))).toBe(true);
        expect(await second.runPromise(f.epoch)).toBe(original!);
      } finally {
        await second.dispose();
      }
    }));

  it("fails closed without a durable row or synchronous settings authority", () =>
    withDatabase("bigbud-metadata-config-missing-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        expect(await runtime.runPromise(configuration.isCurrent("missing"))).toBe(false);
        const original = await runtime.runPromise(epoch);
        const incomplete = { ...settings };
        delete incomplete.onSnapshotChange;
        const missing = await runtime.runPromise(makeMetadataConfiguration(incomplete));
        expect(await runtime.runPromise(missing.isCurrent(original))).toBe(false);
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM thread_metadata_configuration_epoch`;
          }),
        );
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(false);
      } finally {
        await runtime.dispose();
      }
    }));

  it("does not acquire the settings barrier from canonical SQL authority", () =>
    withDatabase("bigbud-metadata-config-lock-order-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        const original = await runtime.runPromise(epoch);
        // This would deadlock if canonical authorization reacquired settings.
        const current = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* settings.withSnapshotBarrier!(() =>
              sql.withTransaction(configuration.isCurrent(original)),
            );
          }).pipe(Effect.timeout("1 second")),
        );
        expect(current).toBe(true);
      } finally {
        await runtime.dispose();
      }
    }));

  it("keeps invalidation fail-closed after epoch persistence fails", () =>
    withDatabase("bigbud-metadata-config-write-failure-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const { settings, configuration, epoch } = await configurationFor(runtime);
        const original = await runtime.runPromise(epoch);
        await runtime.runPromise(
          settings.updateSettings({ textGenerationModelSelection: selection }),
        );
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TEMP TRIGGER reject_configuration_epoch BEFORE INSERT ON thread_metadata_configuration_epoch
            BEGIN SELECT RAISE(ABORT, 'epoch persistence unavailable'); END`;
          }),
        );
        expect((await runtime.runPromise(epoch.pipe(Effect.result)))._tag).toBe("Failure");
        expect(await runtime.runPromise(configuration.isCurrent(original))).toBe(false);
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER reject_configuration_epoch`;
          }),
        );
        expect(await runtime.runPromise(epoch)).not.toBe(original);
      } finally {
        await runtime.dispose();
      }
    }));

  it("rejects stale dispatch without crossing the claim fence", () =>
    withAdmissionFixture(async (f) => {
      await f.runtime.runPromise(
        f.settings.updateSettings({ textGenerationModelSelection: selection }),
      );
      await f.runtime.runPromise(f.settings.updateSettings({ textGenerationModelSelection: null }));
      let claimed = false;
      const result = await f.runtime.runPromise(
        f
          .admit(
            f.context,
            f.context.primaryPath!,
            Effect.sync(() => {
              claimed = true;
            }),
          )
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(claimed).toBe(false);
    }));

  it("rejects stale canonical freshness and accepts retained output only as a stale no-op", () =>
    withDatabase("bigbud-metadata-config-commit-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const { settings } = await configurationFor(runtime);
        const host = await runtime.runPromise(
          makeMetadataCanonicalOperations({ engine: f.engine, settings }),
        );
        expect(await runtime.runPromise(host.isCurrent(f.context))).toBe(true);
        await runtime.runPromise(
          settings.updateSettings({ textGenerationModelSelection: selection }),
        );
        await runtime.runPromise(settings.updateSettings({ textGenerationModelSelection: null }));
        expect(await runtime.runPromise(host.isCurrent(f.context))).toBe(false);
        // Bypass host freshness deliberately: the canonical commit must independently fence it.
        await runtime.runPromise(f.engine.dispatch(f.command, f.options));
        expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
          "stale",
        );
        expect(
          (await runtime.runPromise(f.engine.getReadModel())).threads.find(
            (thread) => thread.id === f.context.threadId,
          )?.title,
        ).toBe(f.originalThread.title);
      } finally {
        await runtime.dispose();
      }
    }));
});
