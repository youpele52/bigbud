import { V2CodingFiles, resolveV2FilePython, type V2CodingTarget } from "./Coding.files.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** Optional bounded helper; its absence must not masquerade as automatic native edit authorization. */
export async function resolveV2OptionalFilePython(profile: string) {
  try {
    return await resolveV2FilePython(profile);
  } catch {
    return undefined;
  }
}

/** Keep canonical orchestration available even when bounded local file operations lack a platform helper. */
export async function openV2OwnedFiles(
  session: V2RuntimeSession,
  profile: string,
  python?: string,
): Promise<V2CodingTarget> {
  if (session.resources?.codingFiles) return session.resources.codingFiles;
  if (python) return V2CodingFiles.open(session.native.location.directory, profile, python);
  return {
    root: session.native.location.directory,
    run: async () => {
      throw new Error(
        "V2 bounded local file helper is unavailable on this platform. Native file tools require explicit approval or user-selected Full access; no automatic edit fallback.",
      );
    },
  };
}
