import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, Logger, Result, Schema } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { ServerConfig } from "@bigbud/contracts/server/server";

import {
  configSchemaDiagnostic,
  observeConfigStage,
  validateServerConfig,
  validateServerConfigEvent,
} from "./wsConfigDiagnostics";

const config: ServerConfig = {
  cwd: "/fixture",
  storage: { notesDir: "/fixture/notes", kanbanDir: "/fixture/kanban" },
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  discovery: { agents: [], skills: [] },
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

it.effect(
  "preserves valid snapshots and rejects invalid output without leaking schema values",
  () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* validateServerConfig(config), config);
      const invalid = { ...config, cwd: "" };
      const exit = yield* Effect.exit(validateServerConfig(invalid));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.equal(
          String(Cause.squash(exit.cause)),
          "Error: Server configuration snapshot is invalid.",
        );
      }
    }),
);

it.effect("validates incremental config events without silently dropping invalid providers", () =>
  Effect.gen(function* () {
    const event = {
      version: 1 as const,
      type: "providerStatuses" as const,
      payload: { providers: [] },
    };
    assert.deepEqual(yield* validateServerConfigEvent(event), event);
    const invalid = {
      ...event,
      payload: { providers: [{ provider: "secret-provider-value" }] },
    } as unknown as Parameters<typeof validateServerConfigEvent>[0];
    const exit = yield* Effect.exit(validateServerConfigEvent(invalid));
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.equal(
        String(Cause.squash(exit.cause)),
        "Error: Server configuration update is invalid.",
      );
    }
  }),
);

it.effect("projects only allowlisted structural areas and issue categories", () =>
  Effect.sync(() => {
    const result = Schema.encodeUnknownResult(ServerConfig)({
      ...config,
      providers: [{ provider: "secret-provider-value", apiKey: "private-credential" }],
    });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      const diagnostic = configSchemaDiagnostic(result.failure);
      assert.equal(diagnostic.area, "providers");
      assert.notInclude(JSON.stringify(diagnostic), "secret-provider-value");
      assert.notInclude(JSON.stringify(diagnostic), "private-credential");
    }
  }),
);

it.effect("retains safe structural indices while redacting arbitrary schema keys", () =>
  Effect.sync(() => {
    const missing = new SchemaIssue.MissingKey(undefined);
    const safe = configSchemaDiagnostic(
      new SchemaIssue.Pointer(["providers", 3, "models", 2, "name"], missing),
    );
    assert.deepEqual(safe, {
      area: "providers",
      structuralPath: "providers[3].models[2].name",
      category: "MissingKey",
    });
    const sentinel = "sentinel-private-provider-credential";
    const redacted = configSchemaDiagnostic(
      new SchemaIssue.Pointer(["providers", 3, "models", 2, sentinel, Symbol(sentinel)], missing),
    );
    assert.equal(redacted.structuralPath, "providers[3].models[2].[redacted].[redacted]");
    assert.notInclude(JSON.stringify(redacted), sentinel);
    const bounded = configSchemaDiagnostic(
      new SchemaIssue.Pointer(
        Array.from({ length: 100 }, () => sentinel),
        missing,
      ),
    );
    assert.isAtMost(bounded.structuralPath.length, 240);
    assert.notInclude(JSON.stringify(bounded), sentinel);
  }),
);

it.effect("does not misclassify cancellation as a producer failure", () => {
  const messages: Array<unknown> = [];
  return observeConfigStage("settings", Effect.interrupt).pipe(
    Effect.exit,
    Effect.tap(() => Effect.sync(() => assert.deepEqual(messages, []))),
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message }) => {
            messages.push(message);
          }),
        ],
        {
          mergeWithExisting: false,
        },
      ),
    ),
  );
});
