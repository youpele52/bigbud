import { execFile } from "node:child_process";
import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const win = path.win32;
const trustedSystemSids = ["S-1-5-18", "S-1-5-32-544"];
const trustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
// Generic write/all, DELETE, WRITE_DAC, WRITE_OWNER, and mutation of existing children/metadata.
const ancestorMutation = 0x500d0150;

export function ordinaryWindowsPickerPath(value: string): string | undefined {
  const name = value.replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//.test(name) || name.length > 230) return undefined;
  for (const part of name.slice(3).split("/")) {
    if (
      !/^[A-Za-z0-9_.-][A-Za-z0-9_. -]*$/.test(part) ||
      /[ .]$/.test(part) ||
      /^(?:AUX|CON|NUL|PRN|COM[0-9]|LPT[0-9])$/i.test(part.split(".")[0]!.trimEnd())
    ) {
      return undefined;
    }
  }
  return name;
}

interface PathCheck {
  readonly name: string;
  readonly directory: boolean;
  readonly private: boolean;
}

function expectedChecks(root: string, files: readonly string[]): PathCheck[] {
  const parents: PathCheck[] = [];
  for (let name = win.dirname(root); ; name = win.dirname(name)) {
    parents.unshift({ name, directory: true, private: false });
    if (name === win.dirname(name)) break;
  }
  return [
    ...parents,
    { name: root, directory: true, private: true },
    ...files.map((name) => ({ name, directory: false, private: true })),
  ];
}

const aclProgram = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json -InputObject $env:BIGBUD_PICKER_ACL_REQUEST
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.checks[0].name))
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'Not a fixed NTFS volume' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = @(
  foreach ($check in $request.checks) {
    $item = Get-Item -LiteralPath $check.name -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    if ($item.PSIsContainer -ne $check.directory) { throw 'Unexpected file type' }
    $acl = Get-Acl -LiteralPath $check.name
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if (-not $descriptor.DiscretionaryAcl) { throw 'Missing DACL' }
    $rules = @(
      foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and
            $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) { throw 'Unsupported ACE' }
        @{
          sid=$ace.SecurityIdentifier.Value
          allow=($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed)
          rights=$ace.AccessMask
          inheritOnly=(($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly) -ne 0)
        }
      }
    )
    @{ owner=$descriptor.Owner.Value; rules=$rules }
  }
)
@{ sid=$sid; entries=$entries } | ConvertTo-Json -Depth 6 -Compress
`;

function invalidAcl(): never {
  throw new Error("The Windows picker fixture requires confirmed local private ACLs.");
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidAcl();
  return value as Record<string, unknown>;
}

/** Inspect the entire DACL, including ACEs inherited from a parent and generic access bits. */
export function validateWindowsPickerAcl(required: readonly boolean[], snapshot: unknown): void {
  const { sid, entries } = object(snapshot);
  if (
    typeof sid !== "string" ||
    !/^S-1-5-[0-9]+(?:-[0-9]+)*$/.test(sid) ||
    !Array.isArray(entries) ||
    entries.length !== required.length
  ) {
    invalidAcl();
  }
  const trusted = new Set([sid, ...trustedSystemSids]);
  const trustedAncestors = new Set([...trusted, trustedInstaller]);
  for (const [index, isPrivate] of required.entries()) {
    const { owner, rules } = object(entries[index]);
    if (
      typeof owner !== "string" ||
      (isPrivate ? owner !== sid : !trustedAncestors.has(owner)) ||
      !Array.isArray(rules)
    ) {
      invalidAcl();
    }
    let hasGrant = false;
    for (const entry of rules) {
      const rule = object(entry);
      if (
        typeof rule.sid !== "string" ||
        !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(rule.sid) ||
        typeof rule.allow !== "boolean" ||
        typeof rule.inheritOnly !== "boolean" ||
        typeof rule.rights !== "number" ||
        !Number.isInteger(rule.rights) ||
        rule.rights < -0x80000000 ||
        rule.rights > 0x7fffffff
      ) {
        invalidAcl();
      }
      if (!rule.allow) continue;
      if (!rule.inheritOnly && rule.rights !== 0) hasGrant = true;
      if (
        isPrivate
          ? !trusted.has(rule.sid)
          : !rule.inheritOnly &&
            !trustedAncestors.has(rule.sid) &&
            (rule.rights & ancestorMutation) !== 0
      ) {
        invalidAcl();
      }
    }
    if (!hasGrant) invalidAcl();
  }
}

const nativeRealpath = promisify(realpath.native);
const execute = promisify(execFile);

export async function assertPrivateWindowsPickerPaths(root: string, files: readonly string[]) {
  // Use the fixed system executable and built-in modules, not a PATH shim or a user profile.
  const systemRoot = ordinaryWindowsPickerPath(process.env.SystemRoot ?? "");
  if (!systemRoot) invalidAcl();
  const system32 = win.join(systemRoot, "System32");
  const powershell = win.join(system32, "WindowsPowerShell", "v1.0");
  const checks = expectedChecks(root, files);
  try {
    const { stdout } = await execute(
      win.join(powershell, "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(aclProgram, "utf16le").toString("base64"),
      ],
      {
        cwd: system32,
        env: {
          SystemRoot: win.normalize(systemRoot),
          PSModulePath: win.join(powershell, "Modules"),
          BIGBUD_PICKER_ACL_REQUEST: JSON.stringify({ checks }),
        },
        maxBuffer: 128 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    validateWindowsPickerAcl(
      checks.map((check) => check.private),
      JSON.parse(stdout),
    );
    // Like the Rust owner, reject mapped/substituted aliases, symlinks and multi-link files.
    // Validate components, not just the final lexical path. Untrusted principals cannot
    // rename or replace them through the verified ancestry before the owner opens them.
    for (const { name, directory } of checks) {
      const info = await lstat(name);
      if (
        (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
        win.normalize(await nativeRealpath(name)).toLowerCase() !==
          win.normalize(name).toLowerCase()
      ) {
        invalidAcl();
      }
    }
  } catch {
    invalidAcl();
  }
}
