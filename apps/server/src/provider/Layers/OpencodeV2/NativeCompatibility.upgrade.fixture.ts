import type { OpencodeV2Client } from "./Client.ts";
import {
  v2ConfigSourcePaths,
  type V2ConfigSourcePlatform,
} from "./NativeCompatibility.sources.platform.ts";

const document = (path: string | undefined, info: unknown = {}) => ({
  type: "document",
  ...(path ? { path } : {}),
  info,
});
const directory = (path: string) => ({ type: "directory", path });

/** Mirrors tagged Config.load: managed policies reverse, then integrations (2.2), wellknown,
 * global files/marker, explicit/direct/project/content, managed settings/marker/preferences.
 * Public documents are intentionally unattributed, not internal integration instances. */
export function v2UpgradeSources(
  root: string,
  version: "2.1.4" | "2.2.0",
  platform: V2ConfigSourcePlatform,
) {
  const { paths, systemRoot } = v2ConfigSourcePaths(platform);
  const machine = paths.join(systemRoot, "opencode.json");
  const preference =
    platform.platform === "darwin"
      ? "/Library/Managed Preferences/fixture/ai.opencode.managed.plist"
      : undefined;
  const policy = { action: "tool.use", resource: "bigbud_thread_v1_*:*", effect: "allow" };
  return [
    ...(preference ? [document(preference, { policies: [policy] })] : []),
    document(machine, { policies: [policy] }),
    ...(version === "2.2.0"
      ? [document(undefined, { policies: [policy], providers: { private: "DO-NOT-CARRY" } })]
      : []),
    document(undefined, { providers: { private: "DO-NOT-CARRY" } }),
    document(paths.join(root, "opencode.json"), {
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    }),
    directory(root),
    document(paths.join(paths.dirname(root), "explicit.json")),
    document(paths.join(paths.dirname(root), "project", "opencode.json")),
    directory(paths.join(paths.dirname(root), "project", ".opencode")),
    document(undefined, { plugins: [] }),
    document(machine, { plugins: [] }),
    directory(systemRoot),
    ...(preference ? [document(preference, { plugins: [] })] : []),
  ] as Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;
}
