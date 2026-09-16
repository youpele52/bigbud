/** Layout recognition only: legacy ownership and artifact authenticity remain unproven. */
export const REMOTE_AGENT_INVENTORY_PATH_CLASSIFIER = `
classify_agent_binary() {
  agent_path=$1
  agent_bin=$2
  case "$agent_path" in
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
  test "\${#agent_version}" -le 64 || { printf unknown; return; }
  case "$agent_version" in
    [A-Za-z0-9]*) ;;
    *) printf unknown; return;;
  esac
  case "$agent_version" in *[!A-Za-z0-9._+-]*) printf unknown; return;; esac
  printf "%s" "$agent_kind"
}
`;
