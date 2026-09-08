import { appendFileSync } from "node:fs";

import {
  formatUnsignedWindowsWarning,
  resolveWindowsSigningMode,
} from "./lib/windows-signing-mode.ts";

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) {
  throw new Error("GITHUB_OUTPUT is required to resolve Windows signing mode.");
}

const mode = resolveWindowsSigningMode(process.env);
appendFileSync(outputPath, `signed=${String(mode.signed)}\nmissing=${mode.missing.join(",")}\n`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (mode.signed) {
  console.log("Windows Authenticode signing is enabled.");
  if (summaryPath)
    appendFileSync(summaryPath, "### Windows signing\n\nAuthenticode signing is enabled.\n");
} else {
  const warning = formatUnsignedWindowsWarning(mode.missing);
  console.log(`::warning title=Unsigned Windows release::${warning}`);
  if (summaryPath) appendFileSync(summaryPath, `### Windows signing\n\n⚠️ ${warning}\n`);
}
