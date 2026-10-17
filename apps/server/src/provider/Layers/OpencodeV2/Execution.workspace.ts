import { V2CodingFiles, resolveV2FilePython } from "./Coding.files.ts";

/** Reject pre-existing inode aliases before giving a command workspace-wide authority; never traverse symlinks. */
export async function inspectV2CommandWorkspace(root: string, profile: string) {
  const files = await V2CodingFiles.open(root, profile, await resolveV2FilePython(profile));
  await files.run({ action: "inspect", path: "." });
}
