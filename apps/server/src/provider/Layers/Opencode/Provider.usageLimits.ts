import { makeHttpUsageLimitsReader } from "../../providerUsageLimits.http.ts";
import { readOpencodeGoUsageCredential } from "./Provider.usageLimits.credentials.ts";
import { normalizeOpencodeGoUsageLimits } from "./Provider.usageLimits.normalize.ts";

// Undocumented Go usage endpoint, independent of OpenCode's connected model backends.
// Reference: https://github.com/steipete/CodexBar/blob/b0aa7fe0add90b06e3614328715d827f1c898a0f/Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift
export const readOpencodeGoUsageLimits = makeHttpUsageLimitsReader({
  source: "opencode-go-api",
  url: "https://opencode.ai/zen/go/v1/usage",
  loadCredential: readOpencodeGoUsageCredential,
  normalize: normalizeOpencodeGoUsageLimits,
});
