import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { V2SharedServiceError, type V2SharedServiceStage } from "./SharedService.errors.ts";
import { V2DiagnosticError } from "./PluginSetup.diagnostics.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { validateV2NativeConfigSources } from "./NativeCompatibility.sources.ts";
import { runV2UpgradeCompiledFixture } from "./NativeCompatibility.upgrade.compiled.fixture.ts";

const secret = "password auth-header config-value /private/account https://private.test";

it.each([
  ["registration", "registration-unverified"],
  ["health", "health-unverified"],
  ["compatibility", "contract-unverified"],
  ["generation", "generation-mismatch"],
  ["storage", "storage-namespace-mismatch"],
  ["unknown", "acquisition-unverified"],
  ["source", "source-root"],
] as const)(
  "manager → actual adapter → serialized error preserves %s, never native causes/replay eligibility",
  async (stage, code) => {
    await withV2RuntimeFixture(async ({ runtime: baseline, directory, http }) => {
      let starts = 0;
      const manager = new OpencodeV2ServerManager({
        maxProcesses: 1,
        maxOwners: 1,
        maxQueuedEvents: 1,
        maxEventBytes: 1024,
        consumerTimeoutMs: 100,
        start: async () => {
          starts++;
          if (stage === "source")
            validateV2NativeConfigSources(
              [{ type: "directory", path: "/private/wrong" }],
              "/fixture/global",
              "v2-global-config-v1",
              { platform: "darwin" },
            );
          const error =
            stage === "unknown"
              ? new Error(secret, { cause: { password: secret } })
              : new V2SharedServiceError(stage as V2SharedServiceStage, secret, secret);
          Object.assign(error, {
            private: secret,
            cause: new Error(secret),
            headers: { authorization: secret },
          });
          throw error;
        },
      });
      try {
        const failure = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { adapter } = yield* makeV2RuntimeAdapter({
                manager,
                journal: baseline.options.journal,
                config: baseline.options.config,
              });
              return yield* Effect.flip(
                adapter.startSession({
                  threadId: ThreadId.makeUnsafe(`diagnostic-${stage}`),
                  cwd: directory,
                  runtimeMode: "approval-required",
                  modelSelection: {
                    provider: "opencodeV2",
                    subProviderID: "synthetic-provider",
                    model: "synthetic-model",
                  },
                }),
              );
            }),
          ),
        );
        expect(failure).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          failureClass: "unsafe-to-replay",
        });
        const serialized = JSON.stringify(failure);
        expect(serialized).toContain(code);
        for (const token of secret.split(" ")) expect(serialized).not.toContain(token);
        expect(starts).toBe(1);
        expect(http.calls).toEqual([]);
      } finally {
        await manager.close();
      }
    });
  },
);

it("diagnostic metadata is runtime allowlisted and bounded, not a spread of arbitrary causes", () => {
  const error = new V2DiagnosticError(secret as never, secret as never, 100000, -1);
  expect(error.diagnostic).toEqual({ stage: "acquisition", code: "acquisition-unverified" });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
});

it("source and release-compiler changed-path fixture share the same offline assertions", async () => {
  const report = await runV2UpgradeCompiledFixture();
  expect(report.supported).toHaveLength(2);
  expect(report.denied).toContain("policy-denied");
  expect(report.serialized).toContain("generation-mismatch");
  expect(report.nativeQualified).toBe(false);
});
