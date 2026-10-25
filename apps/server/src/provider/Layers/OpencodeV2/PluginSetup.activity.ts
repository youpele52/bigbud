import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";

export interface V2NativeActivity {
  readonly foregroundCount: number;
  readonly runningShellCount: number;
  readonly directories: readonly string[];
}

/** Bounded public observations only; never an atomic/global-idle assertion or private-history scan. */
export async function readV2NativeActivity(
  client: OpencodeV2Client,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<V2NativeActivity> {
  const total = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  assertCurrent();
  total.throwIfAborted();
  const [active, locations] = await Promise.all([
    v2Request(
      "activation foreground activity",
      (abort) => client.session.active({ signal: abort }),
      { signal: total, timeoutMs: 5000 },
    ),
    v2Request(
      "activation loaded Locations",
      (abort) => client.debug.location.list({ signal: abort }),
      { signal: total, timeoutMs: 5000 },
    ),
  ]);
  assertCurrent();
  total.throwIfAborted();
  if (
    !active ||
    typeof active !== "object" ||
    Array.isArray(active) ||
    Object.keys(active).length > 1000 ||
    Object.values(active).some((value) => !value || value.type !== "running") ||
    !Array.isArray(locations) ||
    locations.length > 64
  )
    throw new Error(
      "V2 native activity is unknown/over its bound; activation deferred, not inferred idle.",
    );
  const directories = [...new Set(locations.map((location) => location.directory))];
  if (
    directories.some(
      (directory) => typeof directory !== "string" || !directory || directory.length > 4096,
    )
  )
    throw new Error("V2 native activity Location inventory is invalid; activation deferred.");
  let index = 0,
    runningShellCount = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, directories.length) }, async () => {
      for (;;) {
        const directory = directories[index++];
        if (directory === undefined) return;
        assertCurrent();
        total.throwIfAborted();
        const shells = await v2Request(
          "activation Location shell activity",
          (abort) => client.shell.list({ location: { directory } }, { signal: abort }),
          { signal: total, timeoutMs: 5000 },
        );
        assertCurrent();
        total.throwIfAborted();
        if (
          shells.location.directory !== directory ||
          !Array.isArray(shells.data) ||
          shells.data.length > 1000 ||
          shells.data.some(
            (shell) => !["running", "exited", "timeout", "killed"].includes(shell.status),
          )
        )
          throw new Error(
            "V2 native shell activity is unknown/over its bound; activation deferred.",
          );
        // Commands, environment and metadata are never retained in the safe observation.
        runningShellCount += shells.data.filter((shell) => shell.status === "running").length;
      }
    }),
  );
  assertCurrent();
  total.throwIfAborted();
  return { foregroundCount: Object.keys(active).length, runningShellCount, directories };
}
