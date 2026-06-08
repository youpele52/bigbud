import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { createManager, openInput } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect("spawns remote terminals through ssh for remote execution targets", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      const snapshot = yield* manager.open(
        openInput({
          executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
          cwd: "/root/project",
          env: {
            FOO: "bar",
          },
        }),
      );

      expect(snapshot.executionTargetId).toBe("ssh:host=devbox&user=root&port=22&auth=ssh-key");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;
      const spawnArgs = spawnInput.args;
      expect(spawnArgs).toBeDefined();
      if (!spawnArgs) return;

      expect(spawnInput.shell).toBe("ssh");
      expect(spawnArgs.slice(0, 6)).toEqual([
        "-tt",
        "-o",
        "BatchMode=yes",
        "-p",
        "22",
        "root@devbox",
      ]);
      expect(spawnArgs[6]).toContain("'sh' '-lc'");
      expect(spawnArgs[6]).toContain("'FOO=bar'");
      expect(spawnArgs[6]).toContain("'--'");
    }),
  );
});
