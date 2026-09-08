import { resolve } from "node:path";

import {
  smokeTestDesktopSupervisorBinary,
  smokeTestDesktopSupervisorRecovery,
} from "./lib/desktop-supervisor-smoke.ts";

const binaryName =
  process.platform === "win32" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor";
const binaryPath = resolve(process.cwd(), "target", "debug", binaryName);

await smokeTestDesktopSupervisorBinary(binaryPath);
await smokeTestDesktopSupervisorRecovery(binaryPath);
console.log(`Desktop supervisor native smoke passed: ${binaryPath}`);
