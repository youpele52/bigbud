import { bytes, type Message } from "./v1.golden.codec.ts";

const correlation: Message = [
  [1, bytes("0180ff")],
  [2, bytes("002a")],
  [3, bytes("04")],
];

/** Typed errors share one envelope; only the ErrorCode field varies. */
const error = (code: number): Message => [[4, [...correlation, [10, [[1, code]]]]]];

export const errorCases = {
  error_owner_unavailable: error(1),
  error_operation_denied: error(2),
  error_invalid_operands: error(3),
  error_target_disconnected: error(4),
  error_config_unsupported: error(5),
  error_trust_required: error(6),
  error_host_key_changed: error(7),
  error_trust_store_read_only: error(8),
  error_auth_required: error(9),
  error_transport_lost: error(10),
  error_list_failed: error(11),
  error_stale_generation: error(12),
  error_storage_unavailable: error(13),
  error_outcome_unknown: error(14),
  error_list_timed_out: error(15),
  error_list_path_unavailable: error(16),
  error_list_invalid_output: error(17),
  error_workspace_path_denied: error(18),
  error_workspace_read_failed: error(19),
  error_workspace_file_too_large: error(20),
  error_workspace_write_failed: error(21),
  error_proof_ripgrep_unavailable: error(22),
  error_proof_deployment_timeout: error(23),
  error_proof_deployment_output_limit: error(24),
  error_list_cancelled: error(25),
  error_health_cancelled: error(26),
  error_session_quota: error(28),
  error_windows_password_unsupported: error(29),
  error_keyboard_interactive_unsupported: error(30),
  error_owner_retirement_unverified: error(31),
  error_target_unknown: error(34),
  error_target_mismatch: error(35),
  error_pane_unrecoverable: error(36),
  error_target_host_unresolved: error(37),
  error_provider_executable_unavailable: error(38),
  error_terminal_shell_unavailable: error(55),
} satisfies Record<string, Message>;
