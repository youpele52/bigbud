import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { GitManagerTestLayer, makeManager } from "./GitManager.test.helpers.ts";

it.layer(GitManagerTestLayer)("unsupported remote PR workflows stay fenced", (it) => {
  it.effect("rejects PR preparation and PR creation before any repository mutation", () =>
    Effect.gen(function* () {
      const execute = vi.fn(() => Effect.die("Unexpected remote work"));
      const { manager } = yield* makeManager({ gitCore: { execute } as never });
      const prepared = yield* Effect.result(
        manager.preparePullRequestThread({
          cwd: "/workspace",
          executionTargetId: "ssh:fixture",
          operationId: "origin-pr",
          reference: "1",
          mode: "worktree",
        }),
      );
      expect(prepared._tag).toBe("Failure");
      for (const action of ["create_pr", "commit_push_pr"] as const) {
        const result = yield* Effect.result(
          manager.runStackedAction({
            cwd: "/workspace",
            executionTargetId: "ssh:fixture",
            actionId: `origin-${action}`,
            action,
          }),
        );
        expect(result._tag).toBe("Failure");
      }
      expect(execute).not.toHaveBeenCalled();
    }),
  );
});
