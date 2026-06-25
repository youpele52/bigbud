/**
 * Re-export of the work log derivation API. The implementation lives in
 * `./workLog/workLog.ts` (entry derivation) and
 * `./workLog/workLog.payload.ts` (payload extraction helpers).
 */

export {
  deriveWorkLogEntries,
  isPlanBoundaryToolActivity,
  type WorkLogEntry,
} from "./workLog/workLog";

export {
  extractWorkLogPayloadDetails,
  type WorkLogPayloadDetails,
} from "./workLog/workLog.payload";
