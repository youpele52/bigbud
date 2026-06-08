import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, FileSystem, Path } from "effect";

import { KeybindingCommand } from "@bigbud/contracts";
import { ServerConfig } from "../startup/config";
import { Keybindings } from "./keybindings";
import {
  makeKeybindingsLayer,
  readKeybindingsConfig,
  toDetailResult,
  writeKeybindingsConfig,
} from "./keybindings.test-utils";

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces existing custom keybinding for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+j","command":"terminal.toggle"}',
      );

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(firstResult, "expected JSON array");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(secondResult, "expected JSON array");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("fails when config directory is not writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const { dirname } = yield* Path.Path;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "failed to write keybindings config");

      yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;
        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});
