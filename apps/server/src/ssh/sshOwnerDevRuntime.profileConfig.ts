import {
  chmod,
  copyFile,
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDevSshOwnerProfile } from "@bigbud/shared/DevLauncher";
import { SSH_CONFIG_MAX_FILE_BYTES } from "./sshConfigDiscovery.ts";
import {
  type SshConfigAliasHint,
  type SshConfigAliasRefusal,
  resolveProfileAliases,
} from "./sshConfigProfileAliases.ts";

export const DEV_OWNER_SSH_CONFIG = "ssh-config";
const endpointInclude = "fixture-endpoint.conf";

type ProfileConfig = {
  readonly content: string;
  readonly root: string;
  /** Top-level profile config used as the owner snapshot. */
  readonly sourcePath: string;
  readonly alias: string;
  /** Where the selected alias is declared; used only for display. */
  readonly aliasSourcePath: string;
  readonly line: number;
  /** Every concrete alias resolved from the profile, in discovery order. */
  readonly hosts: ReadonlyArray<SshConfigAliasHint>;
  readonly refusals: ReadonlyArray<SshConfigAliasRefusal>;
};

const invalidProfile = () => new Error("Expected a private, disposable SSH owner dev profile.");
const isMissing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export async function readDevOwnerProfileConfig(
  profile: string | undefined,
): Promise<ProfileConfig | undefined> {
  if (!profile || process.platform !== "darwin") return undefined;
  if (!isDevSshOwnerProfile(profile, process.platform, "/private/tmp")) throw invalidProfile();
  const root = await realpath(profile);
  const uid = process.getuid?.();
  const directory = await lstat(root);
  if (
    uid === undefined ||
    !isDevSshOwnerProfile(root, process.platform, "/private/tmp") ||
    path.basename(root) !== path.basename(profile) ||
    !(await lstat(profile)).isDirectory() ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o777) !== 0o700
  )
    throw invalidProfile();
  const sourcePath = path.join(root, DEV_OWNER_SSH_CONFIG);
  const file = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((cause: unknown) => {
    if (!isMissing(cause)) throw invalidProfile();
    return undefined;
  });
  if (!file) return undefined;
  let content: string;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.mode & 0o077 ||
      stat.size > SSH_CONFIG_MAX_FILE_BYTES
    )
      throw invalidProfile();
    const bytes = Buffer.alloc(SSH_CONFIG_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === bytes.length) throw invalidProfile();
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    if (content.includes("\0")) throw invalidProfile();
  } finally {
    await file.close();
  }
  const resolution = await resolveProfileAliases({ root, sourcePath, content }).catch(
    (cause: unknown) => {
      if (cause instanceof Error && cause.message.includes("owner-private")) throw invalidProfile();
      throw cause;
    },
  );
  const selected = resolution.hints[0];
  if (!selected)
    throw new Error("The disposable SSH config must declare at least one literal host alias.");
  return {
    content,
    root,
    sourcePath,
    alias: selected.alias,
    aliasSourcePath: selected.sourcePath,
    line: selected.line,
    hosts: resolution.hints,
    refusals: resolution.refusals,
  };
}

export async function bindDevOwnerAlias(
  fixture: {
    root: string;
    loopback: string;
    port: number;
    user: string;
    identity: string;
    knownHosts: string;
  },
  alias: string,
  profile: ProfileConfig | undefined,
): Promise<{ aliasConfig?: { alias: string; file: string } }> {
  if (process.platform !== "darwin") return {};
  const file = path.join(fixture.root, "owner-alias.conf");
  const endpoint = [
    `  HostName ${fixture.loopback}`,
    `  User ${fixture.user}`,
    `  Port ${fixture.port}`,
    `  IdentityFile ${fixture.identity}`,
    `  UserKnownHostsFile ${fixture.knownHosts}`,
    "",
  ].join("\n");
  const mode = { mode: 0o600, flag: "wx" } as const;
  if (!profile) {
    await writeFile(file, `Host ${alias}\n${endpoint}`, mode);
    return { aliasConfig: { file, alias } };
  }
  // The owner's private scope cannot read the user's profile root, so copy every
  // owner-private include to the same relative path inside the fixture first.
  const discovery = await resolveProfileAliases({
    root: profile.root,
    sourcePath: profile.sourcePath,
    content: profile.content,
  });
  for (const included of discovery.includes) {
    if (included.relative === endpointInclude)
      throw new Error("The disposable SSH config uses a reserved include name.");
    const target = path.join(fixture.root, included.relative);
    const relative = path.relative(fixture.root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(included.path, target);
    await chmod(target, 0o600);
  }
  // Rust resolves the private snapshot with its regular location, include, and route checks.
  await writeFile(path.join(fixture.root, endpointInclude), endpoint, mode);
  await writeFile(file, profile.content, mode);
  return { aliasConfig: { file, alias } };
}
