import type { CuaDriverKnownVersion } from "./release";

/** Decided per pinnable version, so a new pin fails to compile until it is listed here. */
const PID_FILE_HONOURED: Readonly<Record<CuaDriverKnownVersion, boolean>> = {
  "0.9.1": false,
  "0.38.0": true,
};

function requireHostBundleId(hostBundleId: string): string {
  const value = hostBundleId.trim();
  if (!value) {
    throw new Error("Embedded cua-driver invocation requires a host bundle ID.");
  }
  return value;
}

export function cuaDriverEmbeddedEnvironment(
  socketPath: string,
  hostBundleId: string,
): Record<string, string> {
  return {
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: requireHostBundleId(hostBundleId),
    CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS: "300",
    CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS: "60",
    BIGBUD_CUA_ENDPOINT: socketPath,
    BIGBUD_CUA_DRIVER_SOCKET: socketPath,
    BIGBUD_CUA_HOST_BUNDLE_ID: requireHostBundleId(hostBundleId),
  };
}

export function cuaDriverMcpArguments(
  socketPath: string,
  hostBundleId: string,
): ReadonlyArray<string> {
  return [
    "mcp",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    requireHostBundleId(hostBundleId),
  ];
}

/**
 * Whether `serve --pid-file` is honoured, so bigbud can keep the Driver's PID
 * record inside its own runtime directory instead of the shared default
 * (`~/Library/Caches/cua-driver/cua-driver.pid` on macOS, which the installed
 * and the dev daemon would otherwise overwrite and delete for each other).
 *
 * - 0.38.0 honours it: `cli.rs:56` (`pid_file: Option<String>`), `main.rs:671,1056`
 *   (`pid_file.unwrap_or_else(serve::default_pid_file_path)`), written after bind and
 *   removed on shutdown (`serve.rs:969-976,1405-1408`). It does not take part in
 *   socket or lock handling (`serve.rs:2246-2257` reads it only for a log hint).
 * - 0.9.1 parses the flag as a value flag (`cli.rs:181`) but `Command::Serve` has no
 *   `pid_file` field (`cli.rs:45-57,605-610`) and always uses
 *   `serve::default_pid_file_path()` (`main.rs:340,453,644,660`), so passing it would
 *   change the argv for nothing. Unknown versions get the unchanged argv.
 */
export function cuaDriverHonoursPidFile(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    (PID_FILE_HONOURED as Readonly<Record<string, boolean | undefined>>)[version] === true
  );
}

export function cuaDriverServeArguments(
  socketPath: string,
  hostBundleId: string,
  options: {
    readonly pidFile?: string;
    /** An installed theme id; pass only when `cuaDriverHonoursCursorTheme`. */
    readonly cursorTheme?: string;
  } = {},
): ReadonlyArray<string> {
  return [
    "serve",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    requireHostBundleId(hostBundleId),
    ...(options.pidFile ? ["--pid-file", options.pidFile] : []),
    ...(options.cursorTheme ? ["--cursor-theme", options.cursorTheme] : []),
  ];
}
