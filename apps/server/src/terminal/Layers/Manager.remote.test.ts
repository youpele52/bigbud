import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { homedir } from "node:os";
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
      expect(snapshot.dropPathMode).toBe("posix");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;
      const spawnArgs = spawnInput.args;
      expect(spawnArgs).toBeDefined();
      if (!spawnArgs) return;

      expect(spawnInput.shell).toBe("ssh");
      expect(spawnInput.cwd).toBe(homedir());
      expect(spawnArgs.slice(0, 6)).toEqual([
        "-tt",
        "-o",
        "BatchMode=yes",
        "-p",
        "22",
        "root@devbox",
      ]);
      expect(spawnArgs[6]).toContain("'sh' '-lc'");
      expect(spawnArgs[6]).toContain("'/root/project'");
      expect(spawnArgs[6]).toContain("'FOO=bar'");
      expect(spawnArgs[6]).toContain("'--'");
    }),
  );

  it.effect("respawns retained remote terminals without using either remote cwd locally", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const initialTarget = "ssh:host=oldbox&user=root&port=22&auth=ssh-key";
      const updatedTarget = "ssh:host=newbox&user=deploy&port=2222&auth=ssh-key";

      yield* manager.open(
        openInput({
          executionTargetId: initialTarget,
          cwd: "/srv/old-project",
        }),
      );
      const snapshot = yield* manager.open(
        openInput({
          executionTargetId: updatedTarget,
          cwd: "/opt/new-project",
        }),
      );

      expect(snapshot.executionTargetId).toBe(updatedTarget);
      expect(snapshot.cwd).toBe("/opt/new-project");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs.map((input) => input.cwd)).toEqual([homedir(), homedir()]);
      expect(ptyAdapter.spawnInputs[0]?.args).toContain("root@oldbox");
      expect(ptyAdapter.spawnInputs[0]?.args?.at(-1)).toContain("'/srv/old-project'");
      expect(ptyAdapter.spawnInputs[1]?.args).toContain("deploy@newbox");
      expect(ptyAdapter.spawnInputs[1]?.args?.at(-1)).toContain("'/opt/new-project'");
    }),
  );
});
