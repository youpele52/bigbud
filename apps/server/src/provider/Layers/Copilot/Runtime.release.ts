/** Official npm metadata captured 2026-11-02; SDK 1.0.28 declares CLI 1.0.105. */
export const COPILOT_RUNTIME_VERSION = "1.0.105";
export const COPILOT_RUNTIME_SDK_VERSION = "1.0.28";

const RELEASES = {
  "darwin-arm64": [
    "cB4CplzVs+k5dlK3/ukr8M5yNI2i8O+lpA8dpMrh4znxW2lknOS+5ZfA++b9jOSz0PmRvK47Ruvq/FrjP33bNw==",
    181877378,
    120320932,
  ],
  "darwin-x64": [
    "DkqgEvvQxoYbvS55xciNGGo6V18K8gltcqXespReXRa4eBxSYeBeDPO3d0GM1GhBIrjpxHmXtTulCP5YQOItaw==",
    190324998,
    126913270,
  ],
  "linux-arm64": [
    "L7/4Sq1ibeUdD8aE++cubBjr2oWfAFGe0yKjuY5oe0HDZw8QHYAPrZhB2p79Nkg2lIB88REncsf+qWuVVDVPjA==",
    194648761,
    131398559,
  ],
  "linux-x64": [
    "3trlyisQQAnlNy3CvYVRDVWC/WK+0CfDId7dDwNbxTFJ9IgM3aoCPyg+QbGPBUeuYNs4sjgtTqFn5l5yfyHVDg==",
    198515437,
    130166621,
  ],
  "linuxmusl-arm64": [
    "p4iMcOLQ/sp0eOwR56/BByuCkfnQUjywAcrMLrOVLDFYjQdxKBfZGP5wGDPqp3J0XF5Gy+rj6VSzQfz7x6B4lQ==",
    189482156,
    122004723,
  ],
  "linuxmusl-x64": [
    "Ie875DDpje0rwtKgT7k0AMlSuetsGO6hZ3Ry/JoyGYJyZx5ZL5QzTOmngDxato8MchcwcBJf38jk1undPEwe0w==",
    197344976,
    125523042,
  ],
  "win32-arm64": [
    "lfpsYgZLBSqNXnDemKv4g0ofjWBvIlQIJVZjJXEYmLXbP+zZAKJ7L+ebqQlvs/elnxv0naY7a7+gQJ1lMBXNIg==",
    164790472,
    113575126,
  ],
  "win32-x64": [
    "Yiy3loRnNICCzmyTQLMs5KnVg1sQUTDkP5JBHu+YrFvzyWVtHIr4nfuLScx5e34qtxcuq/YOHHf0gk4fnxlHcg==",
    172641980,
    113558624,
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
