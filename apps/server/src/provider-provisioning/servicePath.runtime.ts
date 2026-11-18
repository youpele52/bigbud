/**
 * Which PATH provider executables are resolved and spawned with (WP-5C).
 *
 * - Remote mode: the Rust supervisor starts the backend with a cleared PATH, so the bounded
 *   `discoverServicePath()` (3 s, 64 KiB, no TTY) runs once at startup and its result becomes
 *   the backend's PATH. Provider spawns inherit it and provisioning status resolves executables
 *   against the same entries. The unbounded `fixPath()` (`-ilc`) never runs in remote mode.
 * - Desktop/web: unchanged, `fixPath()` merges the login shell PATH as before.
 */
import * as Effect from "effect/Effect";

import { fixPath } from "../utils/os-jank.ts";
import { discoverServicePath, type ServicePathDiscovery } from "./servicePath.ts";

let remoteDiscovery: ServicePathDiscovery | undefined;

export interface ProviderServicePathDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly discover?: () => Effect.Effect<ServicePathDiscovery>;
  readonly fixPath?: () => void;
}

export const prepareProviderServicePath = Effect.fn("prepareProviderServicePath")(function* (
  mode: string,
  deps: ProviderServicePathDeps = {},
) {
  if (mode !== "remote") {
    (deps.fixPath ?? fixPath)();
    return "inherited" as const;
  }
  const env = deps.env ?? process.env;
  const discovery = yield* (deps.discover ?? (() => discoverServicePath({ env })))();
  if (discovery.path) env.PATH = discovery.path;
  remoteDiscovery = discovery;
  yield* Effect.logInfo("provider service PATH discovered", {
    entries: discovery.entries.length,
    shell: discovery.shell.status,
  });
  return "discovered" as const;
});

/**
 * Entries used to resolve provider executables. Remote mode reuses the startup discovery; other
 * modes search the (already `fixPath`-merged) process PATH without spawning a shell.
 */
export const currentProviderServicePath = Effect.fn("currentProviderServicePath")(function* (
  mode: string,
) {
  if (mode === "remote" && remoteDiscovery) {
    return { source: "discovered" as const, discovery: remoteDiscovery };
  }
  const discovery = yield* discoverServicePath({ shell: null });
  return { source: "inherited" as const, discovery };
});

/** Test seam: forget the remote startup discovery. */
export function resetProviderServicePathForTest(): void {
  remoteDiscovery = undefined;
}
