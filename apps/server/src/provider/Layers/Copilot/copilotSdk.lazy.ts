import { createRequire } from "node:module";

import type * as CopilotSdk from "@github/copilot-sdk";

import { makeOptionalSdk } from "../../optionalSdk.ts";

/**
 * The optional Copilot SDK, loaded on first use. A static import made every backend require the
 * Copilot package at startup; remote backends provision only selected vendors, so a host without
 * Copilot must still boot. Async entry points (`loadCopilotSdk`) run before any sync constructor
 * or option builder (`copilotSdk`).
 *
 * The load stays a literal `createRequire(import.meta.url)` call: it selects the SDK's CommonJS
 * closure, which is the closure the backend graph loader policy reviewed. An ESM `import()`
 * would pull in the SDK's ESM runtime-artifact resolver and koffi's ESM loader instead, two
 * unreviewed dynamic loader sites.
 */
const copilot = makeOptionalSdk<typeof CopilotSdk>("@github/copilot-sdk", async () =>
  createRequire(import.meta.url)("@github/copilot-sdk"),
);

export const loadCopilotSdk = copilot.load;

export function copilotSdk(): typeof CopilotSdk {
  return copilot.loaded();
}
