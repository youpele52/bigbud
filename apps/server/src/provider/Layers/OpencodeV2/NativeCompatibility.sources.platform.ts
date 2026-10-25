import path from "node:path";

export interface V2ConfigSourcePlatform {
  readonly platform: NodeJS.Platform;
  readonly programData?: string | undefined;
}

/** Native config paths are classified without reading or granting writes to machine policy files. */
export function v2ConfigSourcePaths(
  options: V2ConfigSourcePlatform = {
    platform: process.platform,
    programData: process.env.ProgramData,
  },
) {
  const windows = options.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const key = (value: string) => (windows ? value.toLowerCase() : value);
  const canonical = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    !value.includes("\0") &&
    paths.isAbsolute(value) &&
    paths.resolve(value) === value &&
    (!windows || (/^[a-z]:\\/i.test(value) && !value.slice(2).includes(":")));
  const data = options.programData;
  if (
    !["darwin", "linux", "win32"].includes(options.platform) ||
    (windows && (!canonical(data) || paths.dirname(data) === data))
  )
    throw new Error("V2 native system configuration namespace unavailable.");
  const systemRoot =
    options.platform === "darwin"
      ? "/Library/Application Support/opencode"
      : windows
        ? paths.join(data!, "opencode")
        : "/etc/opencode";
  const protectedRoot = options.platform === "darwin" ? "/Library" : windows ? data! : "/etc";
  const same = (a: string, b: string) => key(a) === key(b);
  const protectedPath = (value: string) =>
    same(value, protectedRoot) || key(value).startsWith(key(protectedRoot + paths.sep));
  const machineDocument = (value: string) =>
    ["opencode.json", "opencode.jsonc"].some((name) => same(value, paths.join(systemRoot, name))) ||
    (options.platform === "darwin" &&
      /^\/Library\/Managed Preferences\/(?:[^/]+\/)?ai\.opencode\.managed\.plist$/.test(value));
  return { paths, key, canonical, systemRoot, same, protectedPath, machineDocument };
}
