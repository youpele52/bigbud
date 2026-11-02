/** Official npm metadata captured 2026-11-01; SDK 1.0.26 declares CLI 1.0.103. */
export const COPILOT_RUNTIME_VERSION = "1.0.103";
export const COPILOT_RUNTIME_SDK_VERSION = "1.0.26";

const RELEASES = {
  "darwin-arm64": [
    "5upfa7UdJJQbRRfyrYqaZ81xy0SSXba8HNRNwJYVw1NuONFFt3u7FzPBQJ/XpB/1m/YGPmmK4XRgITAF4oAu+A==",
    181811714,
    120249222,
  ],
  "darwin-x64": [
    "E0gt0Q4UyndutyT5bcEn8gBv7RiBJPkY2oOy4vvbF6nHZ8/+/FS0p7baIfOc6xTjJnS+3rfQ8ts9yCRKiSZa9Q==",
    190246566,
    126834367,
  ],
  "linux-arm64": [
    "QK+rSoLxGD79qWpPGZBhV/9KB/yAOnfTkWsAAcRBdFRO3loSFO/bkKDb88aVrSMY/gue167gTOSpR2BWdFObjg==",
    194517689,
    131317972,
  ],
  "linux-x64": [
    "9qNrzrecDTL4N94tPsxocXC1BJ+CykXGiwKQOdVYzpy26Jd43qLtGfYNIrrr4iQi9lAhQPp64Q5UDAkQ3JZgVw==",
    198449901,
    130078031,
  ],
  "linuxmusl-arm64": [
    "p73LRoSDABSPXX8EeiI/ZC9B30d0Zjp1lEEnG9+I19wh7uMq/V0H8Bi9ZISeAzSve49Bij9likpwGScgy2nw2w==",
    189405196,
    121925970,
  ],
  "linuxmusl-x64": [
    "bLP+ZMIZwXCAPZZ6TlwsazG8aVteD6hw9YXX023gz5BpjffbBfYCvkm7IEFHqhBL4ZeboA+WJ20OBA6qheEH/w==",
    197262464,
    125442864,
  ],
  "win32-arm64": [
    "l7K5K6RDgPmdbaeQl2XjoByGYvvKgk2NPGlLxJOXsaCHLuiulbQbXUFa3c71Pty8e3J64viTqlokB+aLmMGkyw==",
    164708552,
    113492663,
  ],
  "win32-x64": [
    "4UVN1vkK36ztFAynNtPKOSpeNUDe3m5LnsD0gTlmPZOayTA8a+/Mek3hf8xCpCrDpFs+GqmbhXeFgbXF61Glgg==",
    172572860,
    113485450,
  ],
} as const;

export type CopilotRuntimeTarget = keyof typeof RELEASES;

export interface CopilotRuntimeRelease {
  readonly version: string;
  readonly target: CopilotRuntimeTarget;
  readonly packageName: string;
  readonly binaryName: "copilot" | "copilot.exe";
  readonly url: string;
  readonly integrity: string;
  /** Uncompressed package files, never an estimate of archive download size. */
  readonly unpackedBytes: number;
  /** Exact compressed length captured from the official registry's Content-Range. */
  readonly archiveBytes: number;
}

export function copilotNativePackageName(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isMusl: boolean;
}): string | undefined {
  if (input.arch !== "arm64" && input.arch !== "x64") return undefined;
  const platform = input.platform === "linux" && input.isMusl ? "linuxmusl" : input.platform;
  const target = `${platform}-${input.arch}`;
  return Object.hasOwn(RELEASES, target) ? `@github/copilot-${target}` : undefined;
}

/** Selects only an audited pinned release; unsupported platforms never fall back. */
export function resolveCopilotRuntimeRelease(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isMusl: boolean;
}): CopilotRuntimeRelease {
  const packageName = copilotNativePackageName(input);
  if (!packageName) {
    throw new Error(`No Copilot runtime release for ${input.platform}/${input.arch}`);
  }
  const target = packageName.slice("@github/copilot-".length) as CopilotRuntimeTarget;
  const [sha512, unpackedBytes, archiveBytes] = RELEASES[target];
  return {
    version: COPILOT_RUNTIME_VERSION,
    target,
    packageName,
    binaryName: input.platform === "win32" ? "copilot.exe" : "copilot",
    url: `https://registry.npmjs.org/${packageName}/-/copilot-${target}-${COPILOT_RUNTIME_VERSION}.tgz`,
    integrity: `sha512-${sha512}`,
    unpackedBytes,
    archiveBytes,
  };
}
