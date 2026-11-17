import { resolveCopilotRuntimeRelease } from "../../provider/Layers/Copilot/Runtime.release.ts";
import {
  BACKEND_GRAPH_TUPLES,
  type PinnedArtifact,
  type PlatformTuple,
  type ProviderRecipe,
} from "../recipe.ts";

/** Every tuple in the audited Copilot runtime release table (Runtime.release.ts). */
export const COPILOT_CLI_TUPLES: ReadonlyArray<PlatformTuple> = [
  { os: "darwin", arch: "arm64", libc: "none" },
  { os: "darwin", arch: "x64", libc: "none" },
  { os: "linux", arch: "arm64", libc: "glibc" },
  { os: "linux", arch: "x64", libc: "glibc" },
  { os: "linux", arch: "arm64", libc: "musl" },
  { os: "linux", arch: "x64", libc: "musl" },
  { os: "win32", arch: "arm64", libc: "none" },
  { os: "win32", arch: "x64", libc: "none" },
];

/** Reuses the pinned release table; unsupported tuples have no pin and never fall back. */
export function resolveCopilotCliPin(tuple: PlatformTuple): PinnedArtifact | undefined {
  // Linux pins are libc-specific; other OSes have no libc dimension.
  if ((tuple.os === "linux") === (tuple.libc === "none")) return undefined;
  try {
    const release = resolveCopilotRuntimeRelease({
      platform: tuple.os,
      arch: tuple.arch,
      isMusl: tuple.libc === "musl",
    });
    return {
      version: release.version,
      url: release.url,
      integrity: release.integrity,
      archiveBytes: release.archiveBytes,
      unpackedBytes: release.unpackedBytes,
    };
  } catch {
    return undefined;
  }
}

/** Copilot (decision 6): bigbud provisions the pinned CLI runtime; the SDK ships in the graph. */
export const copilotRecipe: ProviderRecipe = {
  kind: "copilot",
  displayName: "Copilot",
  provisionedBy: "bigbud",
  components: [
    {
      kind: "graphExternal",
      id: "copilot-sdk",
      description: "GitHub Copilot SDK and its native runtime addon in the backend graph",
      packages: ["@github/copilot-sdk"],
      tuples: BACKEND_GRAPH_TUPLES,
      nativePrerequisites: [],
      integrity: { kind: "backendGraph" },
    },
    {
      kind: "vendorExecutable",
      id: "copilot-cli",
      description: "Pinned GitHub Copilot CLI runtime installed by Runtime.install.ts",
      suppliedBy: "bigbud",
      tuples: COPILOT_CLI_TUPLES,
      discovery: {
        settingsKey: "providers.copilot.binaryPath",
        commandNames: ["copilot"],
        usesServicePath: false,
      },
      integrity: { kind: "sri", resolve: resolveCopilotCliPin },
    },
  ],
  authReadiness: {
    module: "provider/Layers/Copilot/Provider.ts",
    exportName: "checkCopilotProviderStatus",
    userStep: "gh auth login",
  },
  manual: {
    vendor: "GitHub",
    installCommands: ["npm install -g @github/copilot"],
  },
  notes: [
    "An explicit providers.copilot.binaryPath is used as-is and never replaced by the pin.",
    "An installed payload is not authenticated; readiness comes from the SDK auth status.",
  ],
};
