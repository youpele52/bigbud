import * as nodeFs from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import { flagsFor, resolve } from "./cli-config.remote.test.helpers.ts";

it.layer(NodeServices.layer)("remote CLI startup boundaries", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "bb-rp-" });
    return { fs, path, root, base: path.join(root, "backend"), cwd: path.join(root, "workspace") };
  });

  it.effect("refuses missing authentication before directory creation or port probing", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let probes = 0;
      const error = yield* resolve(
        { ...flagsFor(f.base, f.cwd), authToken: Option.none(), port: Option.none() },
        () => {
          probes++;
        },
      ).pipe(Effect.flip);
      expect(String(error)).toContain("authentication token");
      expect(probes).toBe(0);
      expect(yield* f.fs.exists(f.base)).toBe(false);
      expect(yield* f.fs.exists(f.cwd)).toBe(false);
    }),
  );

  it.effect("defers an automatic remote callback port to the owned listener without probing", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let probes = 0;
      const config = yield* resolve({ ...flagsFor(f.base, f.cwd), port: Option.none() }, () => {
        probes++;
      });
      expect(config.port).toBe(0);
      expect(probes).toBe(0);
    }),
  );

  it.effect("rejects desktop bootstrap flags before attempting to read their descriptor", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* resolve({
        ...flagsFor(f.base, f.cwd),
        bootstrapFd: Option.some(999_999),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("desktop bootstrap");
      expect(yield* f.fs.exists(f.base)).toBe(false);
    }),
  );

  it.effect("creates a private state root and disables desktop bootstrap side effects", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const config = yield* resolve(flagsFor(f.base, f.cwd));
      expect(config.mode).toBe("remote");
      expect(config.host).toBe("127.0.0.1");
      expect(config.noBrowser).toBe(true);
      expect(config.autoBootstrapProjectFromCwd).toBe(false);
      expect(config.remoteSocketPath).toBe(f.path.join(config.stateDir, "remote-backend.sock"));
      expect(config.desktopLifecycleHintFd).toBeUndefined();
      expect(config.desktopOwnershipHandoff).toBeUndefined();
      expect(config.terminalShellInstallEvidence).toBe("existing-or-uncertain");
      const stat = yield* Effect.promise(() => nodeFs.stat(config.stateDir));
      expect(stat.mode & 0o7777).toBe(0o700);
      expect(yield* f.fs.exists(f.path.join(config.stateDir, "backend.lock"))).toBe(false);
    }),
  );

  it.effect(
    "refuses an existing public state root without changing its permissions or creating a lock",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const state = f.path.join(f.base, "userdata");
        yield* Effect.promise(() => nodeFs.mkdir(state, { recursive: true, mode: 0o755 }));
        yield* resolve(flagsFor(f.base, f.cwd)).pipe(Effect.flip);
        expect((yield* Effect.promise(() => nodeFs.stat(state))).mode & 0o7777).toBe(0o755);
        expect(yield* f.fs.exists(f.path.join(state, "backend.lock"))).toBe(false);
        expect(yield* f.fs.exists(f.cwd)).toBe(false);
      }),
  );
});
