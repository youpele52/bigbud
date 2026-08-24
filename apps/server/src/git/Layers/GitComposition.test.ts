import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { RemoteAgentGitExecutorService } from "../../remote-agent/remoteAgentGit.ts";
import { GitCore } from "../Services/GitCore.ts";
import { makeGitCoreLayerLive } from "./GitComposition.ts";
import { GitCoreDependenciesLayer } from "./GitCore.test.helpers.ts";

describe("Git production composition", () => {
  it.effect("constructs GitCore with the configured remote executor", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const remoteExecutorLayer = Layer.succeed(RemoteAgentGitExecutorService, (input) => {
        operations.push(input.operation);
        return Effect.succeed({
          code: 0,
          stdout: "remote status",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });
      const remoteLayer = makeGitCoreLayerLive(remoteExecutorLayer).pipe(
        Layer.provide(GitCoreDependenciesLayer),
      );

      const result = yield* Effect.gen(function* () {
        const git = yield* GitCore;
        return yield* git.execute({
          operation: "composition.test",
          cwd: "/remote/project",
          executionTargetId: "ssh:example",
          args: ["status", "--short"],
        });
      }).pipe(Effect.provide(remoteLayer));

      expect(result.stdout).toBe("remote status");
      expect(operations).toEqual(["composition.test"]);
    }),
  );
});
