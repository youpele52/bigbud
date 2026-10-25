import os from "node:os";
import path from "node:path";

export function resolveOwnershipBaseDir(raw: string | undefined, cwd = process.cwd()): string {
  const value = raw?.trim();
  if (!value) return path.join(os.homedir(), ".bigbud");
  const expanded =
    value === "~"
      ? os.homedir()
      : /^~[/\\]/.test(value)
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(cwd, expanded);
}

export function ownershipStateDir(baseDir: string, development: boolean): string {
  return path.join(baseDir, development ? "dev" : "userdata");
}
