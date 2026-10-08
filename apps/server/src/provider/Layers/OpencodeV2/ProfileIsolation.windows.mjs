import { spawn } from "node:child_process";
import path from "node:path";

export const V2_WINDOWS_ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = ([Console]::In.ReadToEnd() | ConvertFrom-Json).root
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = [Collections.Generic.List[object]]::new()
function Inspect($name, $ancestor) {
  $item = Get-Item -LiteralPath $name -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }
  $acl = Get-Acl -LiteralPath $name
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{sid=$_.IdentityReference.Value; allow=($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow); rights=[int64]$_.FileSystemRights}
  })
  $entries.Add(@{path=$item.FullName; ancestor=$ancestor; directory=$item.PSIsContainer; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; rules=$rules})
  if ($entries.Count -gt 2000) { throw 'ACL inventory exceeds bound' }
}
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
while ($pending.Count) {
  $name = $pending.Pop()
  Inspect $name $false
  if ((Get-Item -LiteralPath $name -Force).PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $name -Force) { $pending.Push($child.FullName); if ($pending.Count -gt 2000) { throw 'ACL inventory exceeds bound' } }
  }
}
$parent = [IO.Directory]::GetParent($root)
while ($parent) { Inspect $parent.FullName $true; $parent = $parent.Parent }
@{sid=$sid; entries=@($entries)} | ConvertTo-Json -Depth 8 -Compress
`;

/** Validate explicit and inherited allow ACEs, not guessed POSIX mode bits on Windows. */
export function validateV2WindowsAcl(root, snapshot) {
  if (
    !snapshot ||
    typeof snapshot.sid !== "string" ||
    !snapshot.sid.startsWith("S-1-5-") ||
    !Array.isArray(snapshot.entries) ||
    !snapshot.entries.length ||
    snapshot.entries.length > 2000
  )
    throw new Error("V2 Windows ACL inventory rejected.");
  const allowed = new Set([snapshot.sid, "S-1-5-18", "S-1-5-32-544"]);
  const canonical = path.win32.resolve(root).toLowerCase();
  const seen = new Set();
  for (const entry of snapshot.entries) {
    if (
      typeof entry.path !== "string" ||
      !Array.isArray(entry.rules) ||
      typeof entry.directory !== "boolean" ||
      typeof entry.ancestor !== "boolean"
    )
      throw new Error("V2 Windows ACL entry rejected.");
    const name = path.win32.resolve(entry.path).toLowerCase();
    const relative = path.win32.relative(canonical, name);
    const ancestor = path.win32.relative(name, canonical);
    if (
      seen.has(name) ||
      (entry.ancestor
        ? !ancestor || ancestor.startsWith("..") || path.win32.isAbsolute(ancestor)
        : relative.startsWith("..") || path.win32.isAbsolute(relative))
    )
      throw new Error("V2 Windows ACL scope rejected.");
    seen.add(name);
    if (entry.ancestor ? !allowed.has(entry.owner) : entry.owner !== snapshot.sid)
      throw new Error("V2 Windows profile owner rejected.");
    let grants = 0;
    for (const rule of entry.rules) {
      if (
        typeof rule.sid !== "string" ||
        typeof rule.allow !== "boolean" ||
        !Number.isSafeInteger(rule.rights)
      )
        throw new Error("V2 Windows ACL rule rejected.");
      if (!rule.allow) continue;
      grants++;
      // Reject unknown principals with any private-root rights or ancestor mutation rights.
      if (!allowed.has(rule.sid) && (!entry.ancestor || rule.rights & 852310))
        throw new Error("V2 Windows profile ACL permits an untrusted principal.");
    }
    if (!grants) throw new Error("V2 Windows empty/unknown DACL rejected.");
  }
  if (!seen.has(canonical)) throw new Error("V2 Windows root ACL absent.");
  for (let parent = path.win32.dirname(canonical); parent !== canonical; ) {
    if (!seen.has(parent)) throw new Error("V2 Windows ancestor ACL absent.");
    const next = path.win32.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

export async function inspectV2WindowsAcl(root, signal) {
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : undefined;
  if (!executable || !path.win32.isAbsolute(root))
    throw new Error("V2 Windows trusted PowerShell/absolute profile unavailable.");
  const child = spawn(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(V2_WINDOWS_ACL_PROGRAM, "utf16le").toString("base64"),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
  );
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5000);
  try {
    const output = await new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.stdout.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 2000000) abort();
      });
      child.on("close", (code) => {
        if (code !== 0 || bytes.length > 2000000 || signal?.aborted)
          reject(new Error("V2 Windows ACL inspection unavailable or unconfirmed."));
        else resolve(bytes);
      });
      child.stdin.end(JSON.stringify({ root }));
    });
    validateV2WindowsAcl(
      root,
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
