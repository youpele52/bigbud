import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";

import { FileSystem, Path, Effect } from "effect";

import type { SpawnProcess } from "./open.launch";

export interface RecordedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
}

/** A `spawn` stand-in that records each call and then emits `spawn` (or `error`). */
export function recordingSpawn(failWith?: Error) {
  const calls: RecordedSpawn[] = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    queueMicrotask(() => {
      if (failWith) child.emit("error", failWith);
      else child.emit("spawn");
    });
    return child as unknown as ReturnType<SpawnProcess>;
  };
  return { calls, spawnProcess };
}

/** A temp PATH directory holding stub executables (POSIX execute bit set; Windows by extension). */
export const makeCommandDirectory = Effect.fn("makeCommandDirectory")(function* (
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
  for (const name of names) {
    yield* fs.writeFileString(path.join(dir, name), "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(path.join(dir, name), 0o755);
  }
  return dir;
});
