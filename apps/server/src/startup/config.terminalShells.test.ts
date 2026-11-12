import { lstat, symlink } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { captureTerminalShellInstallEvidence } from "./config.terminalShells.ts";

it.layer(NodeServices.layer)("terminal shell install evidence", (it) => {
  it.effect("only absent web roots are fresh; empty roots and dangling links are prior state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-shell-evidence-" });
      const root = path.join(base, "userdata");
      expect(yield* captureTerminalShellInstallEvidence(root, "web")).toBe("fresh");
      expect(yield* captureTerminalShellInstallEvidence(root, "desktop")).toBe(
        "existing-or-uncertain",
      );
      yield* fs.makeDirectory(root);
      expect(yield* captureTerminalShellInstallEvidence(root, "web")).toBe("existing-or-uncertain");
      yield* fs.remove(root, { recursive: true });
      yield* Effect.promise(() => symlink(path.join(base, "missing"), root));
      expect((yield* Effect.promise(() => lstat(root))).isSymbolicLink()).toBe(true);
      expect(yield* captureTerminalShellInstallEvidence(root, "web")).toBe("existing-or-uncertain");
    }),
  );
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    it.effect(`treats ${code} as uncertainty, not absence`, () =>
      Effect.gen(function* () {
        const evidence = yield* captureTerminalShellInstallEvidence("/unused", "web", () =>
          Promise.reject(Object.assign(new Error(code), { code })),
        );
        expect(evidence).toBe("existing-or-uncertain");
      }),
    );
  }
});
