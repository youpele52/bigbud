/** Layout recognition only: legacy ownership and artifact authenticity remain unproven. */
export const REMOTE_AGENT_INVENTORY_PATH_CLASSIFIER = `
valid_agent_version() {
  candidate_version=$1
  test -n "$candidate_version"
  test "\${#candidate_version}" -le 64
  case "$candidate_version" in
    [A-Za-z0-9]*) ;;
    *) return 1;;
  esac
  case "$candidate_version" in *[!A-Za-z0-9._+-]*) return 1;; esac
}

classify_agent_path() {
  agent_path=$1
  agent_bin=$2
  case "$agent_path" in
    "$agent_bin"/*/target-triple)
      agent_relative=\${agent_path#"$agent_bin"/}
      agent_version=\${agent_relative%/target-triple}
      case "$agent_version" in */*) printf unknown; return;; esac
      valid_agent_version "$agent_version" || { printf unknown; return; }
      test "$agent_version" = 0.2.205 || { printf unknown; return; }
      test "$(readlink -f -- "$agent_path")" = "$agent_path" || { printf unknown; return; }
      test "$(stat -c '%u' -- "$agent_path")" = "$(id -u)" || { printf unknown; return; }
      test "$(stat -c '%a' -- "$agent_path")" = 600 || { printf unknown; return; }
      agent_target=$(cat -- "$agent_path") || { printf unknown; return; }
      # v0.2.205 wrote this sidecar with printf '%s\\n'. Command substitution
      # removes the newline, so the file must contain exactly one byte more.
      test "$(wc -c < "$agent_path")" -eq "$((\${#agent_target} + 1))" || { printf unknown; return; }
      case "$agent_target" in
        aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu) printf metadata; return;;
        *) printf unknown; return;;
      esac
      ;;
    "$agent_bin"/*/bigbud-remote-agent) ;;
    *) printf unknown; return;;
  esac
  agent_relative=\${agent_path#"$agent_bin"/}
  agent_directory=\${agent_relative%/bigbud-remote-agent}
  case "$agent_directory" in
    */*)
      agent_version=\${agent_directory%%/*}
      agent_digest=\${agent_directory#*/}
      test "\${#agent_digest}" -eq 64 || { printf unknown; return; }
      case "$agent_digest" in *[!a-f0-9]*) printf unknown; return;; esac
      agent_kind=managed
      ;;
    *) agent_version=$agent_directory; agent_kind=legacy;;
  esac
  valid_agent_version "$agent_version" || { printf unknown; return; }
  printf "%s" "$agent_kind"
}
`;
