import { createRequire } from "node:module";

import type * as CopilotSdk from "@github/copilot-sdk";

let loaded: typeof CopilotSdk | undefined;

/**
 * Load the optional Copilot SDK on first use. A static import made every backend require the
 * Copilot package at startup; remote backends provision only selected vendors, so a host
 * without Copilot must still boot. Failure surfaces when Copilot is actually used.
 */
export function copilotSdk(): typeof CopilotSdk {
  loaded ??= createRequire(import.meta.url)("@github/copilot-sdk") as typeof CopilotSdk;
  return loaded;
}
