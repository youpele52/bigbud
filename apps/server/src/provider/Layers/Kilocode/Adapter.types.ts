/**
 * KilocodeAdapter types, interfaces, and constants.
 *
 * KiloCode is a fork of OpenCode and shares the same SDK protocol.
 * This module re-exports OpenCode session types and defines the
 * KiloCode-specific provider constant.
 *
 * @module KilocodeAdapter.types
 */

export const PROVIDER = "kilocode" as const;

export type {
  PendingPermissionRequest,
  PendingUserInputRequest,
  MutableTurnSnapshot,
  ActiveOpencodeSession as ActiveKilocodeSession,
} from "../Opencode/Adapter.types.ts";

export type { OpencodeAdapterLiveOptions as KilocodeAdapterLiveOptions } from "../Opencode/Adapter.types.ts";
