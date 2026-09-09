import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { effortCacheKey } from "./effortCache.types.ts";
import { makeEffortCacheIdentity } from "./effortCache.identity.ts";
import {
  loadEffortCapabilityCache,
  rememberEffortCacheEntries,
  resetEffortCapabilityCacheForTests,
  saveEffortCapabilityCache,
} from "./effortCache.persist.ts";
import { EFFORT_CAPABILITY_CACHE_MAX_BYTES } from "./effortCache.types.ts";

describe("effort capability cache persistence", () => {
  it.layer(NodeServices.layer)("disk load and stale writes", (it) => {
    it.effect("loads corrupt files as empty and skips superseded disk writes", () =>
      Effect.gen(function* () {
        resetEffortCapabilityCacheForTests();
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const stateDir = mkdtempSync(path.join(os.tmpdir(), "effort-cache-"));
        const cacheDir = path.join(stateDir, "effort-capabilities");
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(path.join(cacheDir, "v1.json"), "{not-json");

        const loaded = yield* loadEffortCapabilityCache({
          fileSystem,
          path: pathService,
          stateDir,
        });
        assert.deepStrictEqual(loaded.entries, {});

        const identity = makeEffortCacheIdentity({
          provider: "opencode",
          executionIdentity: "opencode",
          configFingerprint: "cfg",
          workspaceFingerprint: "ws",
          subProviderID: "openai",
          modelID: "gpt-5.4",
        });
        rememberEffortCacheEntries({
          stateDir,
          generation: 2,
          entries: [
            [
              effortCacheKey(identity),
              {
                status: "verified-supported",
                levels: [{ value: "xhigh", label: "Extra High" }],
                verifiedAt: "2026-09-09T12:00:00.000Z",
                generation: 2,
              },
            ],
          ],
        });
        yield* saveEffortCapabilityCache({
          fileSystem,
          path: pathService,
          stateDir,
          generation: 1,
        });
        assert.strictEqual(readFileSync(path.join(cacheDir, "v1.json"), "utf8"), "{not-json");

        yield* saveEffortCapabilityCache({
          fileSystem,
          path: pathService,
          stateDir,
          generation: 2,
        });
        const written = JSON.parse(readFileSync(path.join(cacheDir, "v1.json"), "utf8")) as {
          entries: Record<string, unknown>;
        };
        assert.isTrue(Object.keys(written.entries).length > 0);
      }),
    );

    it.effect("serializes concurrent provider scopes into one bounded cache file", () =>
      Effect.gen(function* () {
        resetEffortCapabilityCacheForTests();
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const stateDir = mkdtempSync(path.join(os.tmpdir(), "effort-cache-concurrent-"));
        const first = makeEffortCacheIdentity({
          provider: "codex",
          executionIdentity: "codex",
          configFingerprint: "one",
          workspaceFingerprint: "workspace",
          modelID: "gpt-5.4",
        });
        const second = makeEffortCacheIdentity({
          provider: "claudeAgent",
          executionIdentity: "claude",
          configFingerprint: "two",
          workspaceFingerprint: "workspace",
          modelID: "claude-sonnet",
        });
        rememberEffortCacheEntries({
          stateDir,
          scopeKey: "codex",
          generation: 1,
          entries: [
            [
              effortCacheKey(first),
              {
                status: "verified-supported",
                levels: [{ value: "high", label: "High" }],
                verifiedAt: "2026-09-09T12:00:00.000Z",
                generation: 1,
              },
            ],
          ],
        });
        rememberEffortCacheEntries({
          stateDir,
          scopeKey: "claudeAgent",
          generation: 1,
          entries: [
            [
              effortCacheKey(second),
              {
                status: "verified-supported",
                levels: [{ value: "max", label: "Max" }],
                verifiedAt: "2026-09-09T12:01:00.000Z",
                generation: 1,
              },
            ],
          ],
        });

        yield* Effect.all(
          [
            saveEffortCapabilityCache({
              fileSystem,
              path: pathService,
              stateDir,
              generation: 1,
              scopeKey: "codex",
            }),
            saveEffortCapabilityCache({
              fileSystem,
              path: pathService,
              stateDir,
              generation: 1,
              scopeKey: "claudeAgent",
            }),
          ],
          { concurrency: "unbounded" },
        );

        const encoded = readFileSync(path.join(stateDir, "effort-capabilities", "v1.json"), "utf8");
        assert.isAtMost(
          new TextEncoder().encode(encoded).byteLength,
          EFFORT_CAPABILITY_CACHE_MAX_BYTES,
        );
        const written = JSON.parse(encoded) as { entries: Record<string, unknown> };
        assert.isTrue(Object.hasOwn(written.entries, effortCacheKey(first)));
        assert.isTrue(Object.hasOwn(written.entries, effortCacheKey(second)));
      }),
    );

    it.effect("rejects oversized cache payloads", () =>
      Effect.gen(function* () {
        resetEffortCapabilityCacheForTests();
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const stateDir = mkdtempSync(path.join(os.tmpdir(), "effort-cache-oversized-"));
        const cacheDir = path.join(stateDir, "effort-capabilities");
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(
          path.join(cacheDir, "v1.json"),
          JSON.stringify({
            version: 1,
            entries: { oversized: "x".repeat(EFFORT_CAPABILITY_CACHE_MAX_BYTES) },
          }),
        );

        const loaded = yield* loadEffortCapabilityCache({
          fileSystem,
          path: pathService,
          stateDir,
        });
        assert.deepStrictEqual(loaded.entries, {});
      }),
    );
  });
});
