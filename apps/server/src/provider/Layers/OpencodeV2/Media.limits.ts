import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@bigbud/contracts/orchestration/orchestration.provider.ts";

// Shared per-file contract; aggregate is bounded independently because native inline media is reflected in history/events.
export const V2_MEDIA_FILE_BYTES = Math.max(
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
);
export const V2_MEDIA_TOTAL_BYTES = 16 * 1024 * 1024;
export const V2_MEDIA_RESPONSE_BYTES = 24 * 1024 * 1024;
