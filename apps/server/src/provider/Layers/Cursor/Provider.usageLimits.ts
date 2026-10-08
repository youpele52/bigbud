import { makeHttpUsageLimitsReader } from "../../providerUsageLimits.http.ts";
import { readCursorUsageCredential } from "./Provider.usageLimits.credentials.ts";
import { normalizeCursorUsageLimits } from "./Provider.usageLimits.normalize.ts";

// Undocumented dashboard endpoint, isolated from the Cursor CLI integration.
// Reference: https://github.com/steipete/CodexBar/blob/b0aa7fe0add90b06e3614328715d827f1c898a0f/docs/cursor.md
export const readCursorUsageLimits = makeHttpUsageLimitsReader({
  source: "cursor-dashboard",
  url: "https://cursor.com/api/usage-summary",
  loadCredential: readCursorUsageCredential,
  normalize: normalizeCursorUsageLimits,
});
