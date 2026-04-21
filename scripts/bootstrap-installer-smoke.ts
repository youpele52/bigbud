import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ps1 = readFileSync(join(repoRoot, "apps/marketing/public/install.ps1"), "utf8");

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

// Regression: Start-Process must NOT receive an empty ArgumentList.
// The old code built `$arguments = @()` and always passed
// `-ArgumentList $arguments`, which PowerShell rejects when the array is empty.
assertNotContains(
  ps1,
  "-ArgumentList $arguments",
  "install.ps1 must not pass a variable ArgumentList to Start-Process (empty-array bug). Use separate branches for silent vs interactive mode instead.",
);

// The interactive path must NOT include -ArgumentList at all.
// Extract the else-branch and verify it has no ArgumentList parameter.
const interactiveBranchMatch = ps1.match(
  /\}\s*else\s*\{\s*\n\s*\$process\s*=\s*Start-Process\s+-FilePath\s+\$installerPath\s+-Wait\s+-PassThru/,
);
if (!interactiveBranchMatch) {
  throw new Error(
    "install.ps1: interactive branch must call Start-Process with only -FilePath -Wait -PassThru (no -ArgumentList).",
  );
}

// The silent path must pass /S as a literal string, not via a variable array.
const silentBranchMatch = ps1.match(
  /\$env:BIGBUD_INSTALL_SILENT\s*-eq\s*"1"\s*\)\s*\{\s*\n\s*\$process\s*=\s*Start-Process\s+-FilePath\s+\$installerPath\s+-ArgumentList\s+"\/S"\s+-Wait\s+-PassThru/,
);
if (!silentBranchMatch) {
  throw new Error(
    'install.ps1: silent branch must call Start-Process with -ArgumentList "/S" (literal string, not variable).',
  );
}

// Script must end by calling Install-WindowsRelease (the entry point).
assertContains(
  ps1,
  "Install-WindowsRelease",
  "install.ps1 must call Install-WindowsRelease as its entry point.",
);

// Must use $ErrorActionPreference = "Stop" for fail-fast behavior.
assertContains(
  ps1,
  '$ErrorActionPreference = "Stop"',
  'install.ps1 must set $ErrorActionPreference = "Stop" for fail-fast behavior.',
);

console.log("Bootstrap installer smoke checks passed.");
