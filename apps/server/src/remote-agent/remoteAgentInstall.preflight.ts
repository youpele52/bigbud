import type { RemoteAgentFailureKind } from "./remoteAgentFailure.classify.ts";

/** Tools the install/registry scripts invoke; reported before any bytes are uploaded. */
const REQUIRED_TOOLS = [
  "sha256sum",
  "flock",
  "base64",
  "mktemp",
  "awk",
  "install",
  "stat",
  "readlink",
  "sync",
] as const;
/** GNU option behaviour the scripts rely on, probed without side effects. */
const REQUIRED_FEATURES = {
  "stat-c": "stat -c '%a' / >/dev/null 2>&1",
  "readlink-f": "readlink -f -- / >/dev/null 2>&1",
  "sync-f": "sync -f /dev/null >/dev/null 2>&1",
} as const;
const MANAGED_DIRECTORIES = [".bigbud/agent", ".bigbud/agent/bin", ".bigbud/agent/staging"];

export interface RemoteAgentPreflightDirectory {
  readonly label: string;
  readonly state: "absent" | "ok" | "unsafe";
  readonly detail: string | null;
}

export interface RemoteAgentPreflightReport {
  readonly libc: {
    readonly family: "glibc" | "musl" | "unknown";
    readonly version: string | null;
  };
  readonly missingTools: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<RemoteAgentPreflightDirectory>;
}

export class RemoteAgentPreflightError extends Error {
  readonly _tag = "RemoteAgentPreflightError";

  constructor(
    readonly kind: RemoteAgentFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentPreflightError";
  }
}

/** Shell fragment appended to the platform probe; one SSH round trip covers both. */
export function buildRemoteAgentPreflightScript(): string {
  const tools = REQUIRED_TOOLS.map(
    (tool) =>
      `if command -v ${tool} >/dev/null 2>&1; then printf 'tool.${tool}=yes\\n'; else printf 'tool.${tool}=no\\n'; fi`,
  );
  const features = Object.entries(REQUIRED_FEATURES).map(
    ([name, probe]) =>
      `if ${probe}; then printf 'feature.${name}=yes\\n'; else printf 'feature.${name}=no\\n'; fi`,
  );
  return [
    "if command -v ldd >/dev/null 2>&1; then",
    "  libc=$(ldd --version 2>&1 | head -n 2 | tr '\\n' ' ')",
    "else libc=missing; fi",
    "printf 'libc=%s\\n' \"$libc\"",
    ...tools,
    ...features,
    `for dir in ${MANAGED_DIRECTORIES.join(" ")}; do`,
    '  path="$HOME/$dir"',
    '  if [ -L "$path" ]; then printf \'dir.%s=symlink\\n\' "$dir"',
    '  elif [ ! -e "$path" ]; then printf \'dir.%s=absent\\n\' "$dir"',
    '  elif [ ! -d "$path" ]; then printf \'dir.%s=not-a-directory\\n\' "$dir"',
    "  else",
    '    owner=other; [ "$(stat -c \'%u\' "$path" 2>/dev/null)" = "$(id -u)" ] && owner=self',
    '    printf \'dir.%s=mode=%s,owner=%s\\n\' "$dir" "$(stat -c \'%a\' "$path" 2>/dev/null)" "$owner"',
    "  fi",
    "done",
  ].join("\n");
}

function parseLibc(value: string | undefined): RemoteAgentPreflightReport["libc"] {
  if (!value || value === "missing") return { family: "unknown", version: null };
  if (/musl/i.test(value)) {
    return { family: "musl", version: value.match(/Version\s+(\d+(?:\.\d+)+)/i)?.[1] ?? null };
  }
  if (/glibc|gnu libc|gnu c library/i.test(value)) {
    return {
      family: "glibc",
      version: value.match(/(\d+\.\d+)(?:\.\d+)?\s*(?:$|\s)/)?.[1] ?? null,
    };
  }
  return { family: "unknown", version: null };
}

/** Parse key=value preflight lines; absent keys are "not reported", never "missing". */
export function parseRemoteAgentPreflight(
  lines: ReadonlyArray<string>,
): RemoteAgentPreflightReport {
  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const missingTools = [
    ...REQUIRED_TOOLS.filter((tool) => values.get(`tool.${tool}`) === "no"),
    ...Object.keys(REQUIRED_FEATURES)
      .filter((feature) => values.get(`feature.${feature}`) === "no")
      .filter((feature) => values.get(`tool.${feature.split("-")[0]}`) !== "no")
      .map((feature) => feature.replace("-", " -")),
  ];
  const directories = MANAGED_DIRECTORIES.flatMap((label): RemoteAgentPreflightDirectory[] => {
    const value = values.get(`dir.${label}`);
    if (value === undefined) return [];
    if (value === "absent") return [{ label, state: "absent", detail: null }];
    if (value === "mode=700,owner=self") return [{ label, state: "ok", detail: null }];
    return [{ label, state: "unsafe", detail: value.replace(/,/g, ", ") }];
  });
  return { libc: parseLibc(values.get("libc")), missingTools, directories };
}

/**
 * Refuse before download/upload only for facts that certainly block installation: missing tools
 * the install scripts execute and unsafe managed directories. libc compatibility is NOT inferred
 * from the triple or an assumed glibc floor; the candidate's real `--check` decides, and its
 * loader error names the exact required version (see the failure classifier). A missing `ldd`
 * is purely diagnostic.
 */
export function assertRemoteAgentPreflight(report: RemoteAgentPreflightReport): void {
  if (report.missingTools.length > 0) {
    throw new RemoteAgentPreflightError(
      "missing-tool",
      `The remote host is missing tools agent installation requires: ${report.missingTools.join(", ")}. Install GNU coreutils, util-linux (flock) and awk on the remote host, then retry.`,
    );
  }
  const unsafe = report.directories.find((directory) => directory.state === "unsafe");
  if (unsafe) {
    throw new RemoteAgentPreflightError(
      "directory-permissions",
      `The remote directory ~/${unsafe.label} must be a real directory owned by the SSH account with mode 700 (found ${unsafe.detail}). Run \`chmod 700 ~/${unsafe.label}\` on the remote host, or fix its ownership, then retry.`,
    );
  }
}
