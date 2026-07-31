import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  loadProviderCapabilityContextState,
  persistProviderCapabilityContextState,
} from "./ProviderCapabilityContextPersistence.ts";

describe("ProviderCapabilityContextPersistence", () => {
  it.effect("round trips diagnostic-only state without storing thread content", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "bigbud-capability-context-",
      });
      const threadId = "thread-private-prompt";
      const state = {
        finalizedHumanPromptCount: 7,
        hasObservedMcpStatus: true,
        lastCatalogRevision: "catalog-revision",
        lastCompactionActivityId: "compaction-activity",
        lastMcpStatusActivityId: "mcp-activity",
        lastMemoryHash: "memory-hash",
        needsLp: false,
      };

      yield* persistProviderCapabilityContextState({
        fileSystem,
        path,
        stateDir,
        threadId,
        state,
      });

      expect(
        yield* loadProviderCapabilityContextState({
          fileSystem,
          path,
          stateDir,
          threadId,
        }),
      ).toEqual(state);

      const files = yield* fileSystem.readDirectory(path.join(stateDir, "capability-context"));
      const serialized = yield* fileSystem.readFileString(
        path.join(stateDir, "capability-context", files[0]!),
      );
      expect(serialized).not.toContain(threadId);
      expect(serialized).not.toContain("private prompt");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
