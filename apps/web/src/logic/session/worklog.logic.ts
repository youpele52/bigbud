/**
 * Work log derivation: extracts, normalises, and collapses tool activity
 * entries from OrchestrationThreadActivity streams into WorkLogEntry arrays.
 *
 * Implementation lives in `@bigbud/shared/workLog`. This module is a thin
 * re-export kept for backward compatibility with existing web imports.
 */

export {
  deriveWorkLogEntries,
  extractWorkLogPayloadDetails,
  isPlanBoundaryToolActivity,
  type WorkLogEntry,
  type WorkLogPayloadDetails,
} from "@bigbud/shared/workLog";
